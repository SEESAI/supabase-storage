import pg, { DatabaseError } from 'pg'
import { Knex, knex } from 'knex'
import { JwtPayload } from 'jsonwebtoken'
import retry from 'async-retry'
import TTLCache from '@isaacs/ttlcache'
import { getConfig } from '../../config'
import { DbActiveConnection, DbActivePool } from '../monitoring/metrics'
import KnexTimeoutError = knex.KnexTimeoutError
import { logger, logSchema } from '../monitoring'
import { ERRORS } from '@internal/errors'
import { nextTick } from 'node:process'

// https://github.com/knex/knex/issues/387#issuecomment-51554522
pg.types.setTypeParser(20, 'text', parseInt)

const {
  isMultitenant,
  databaseSSLRootCert,
  databaseMaxConnections,
  databaseFreePoolAfterInactivity,
  databaseConnectionTimeout,
  dbSearchPath,
  dbPostgresVersion,
} = getConfig()

interface TenantConnectionOptions {
  user: User
  superUser: User

  tenantId: string
  dbUrl: string
  isExternalPool?: boolean
  maxConnections: number
  headers?: Record<string, string | undefined | string[]>
  method?: string
  path?: string
  operation?: () => string | undefined
}

export interface User {
  jwt: string
  payload: { role?: string } & JwtPayload
}

export const connections = new TTLCache<string, Knex>({
  ttl: databaseFreePoolAfterInactivity,
  updateAgeOnGet: true,

  dispose: async (pool) => {
    if (!pool) return
    try {
      await pool.destroy()
    } catch (e) {
      logSchema.error(logger, 'pool was not able to be destroyed', {
        type: 'db',
        error: e,
      })
    }
  },
})

export const searchPath = ['storage', 'public', 'extensions', ...dbSearchPath.split(',')].filter(
  Boolean
)

export class TenantConnection {
  public readonly role: string

  constructor(public readonly pool: Knex, protected readonly options: TenantConnectionOptions) {
    this.role = options.user.payload.role || 'anon'
  }

  static stop() {
    const promises: Promise<void>[] = []

    for (const [connectionString, pool] of connections) {
      promises.push(pool.destroy())
      connections.delete(connectionString)
    }

    return Promise.allSettled(promises)
  }

  static async create(options: TenantConnectionOptions) {
    const connectionString = options.dbUrl

    let knexPool = connections.get(connectionString)

    if (knexPool) {
      return new this(knexPool, options)
    }

    const isExternalPool = Boolean(options.isExternalPool)

    knexPool = knex({
      client: 'pg',
      version: dbPostgresVersion,
      searchPath: isExternalPool ? undefined : searchPath,
      pool: {
        min: 0,
        max: options.maxConnections || databaseMaxConnections,
        acquireTimeoutMillis: databaseConnectionTimeout,
        idleTimeoutMillis: isExternalPool ? 100 : databaseFreePoolAfterInactivity,
        reapIntervalMillis: isExternalPool ? 50 : undefined,
      },
      connection: {
        connectionString: connectionString,
        connectionTimeoutMillis: databaseConnectionTimeout,
        ...this.sslSettings(),
      },
      acquireConnectionTimeout: databaseConnectionTimeout,
    })

    DbActivePool.inc({ is_external: isExternalPool.toString() })

    knexPool.client.pool.on('createSuccess', () => {
      DbActiveConnection.inc({
        is_external: isExternalPool.toString(),
      })
    })

    knexPool.client.pool.on('destroySuccess', () => {
      DbActiveConnection.dec({
        is_external: isExternalPool.toString(),
      })
    })

    knexPool.client.pool.on('poolDestroySuccess', () => {
      DbActivePool.dec({ is_external: isExternalPool.toString() })
    })

    if (!isExternalPool || !isMultitenant) {
      connections.set(connectionString, knexPool)

      // HACK: tarn.js validates this value is non-zero so cannot be set in the initialization
      // options and must be overwritten afterwards instead.
      knexPool.client.pool.idleTimeoutMillis = 0

      // HACK: the reap interval cannot be disabled so we set it to the maximum possible value
      // instead. Note that the delay argument is converted to a signed 32-bit integer so
      // larger (or potentially infinite) values will not work as expected.
      knexPool.client.pool.reapIntervalMillis = 2_147_483_647 // MAX_INT32

      // HACK: try to release idle resources immediately. Run the check in the next process tick
      // as this handler runs immediately before resources are actually released.
      knexPool.client.pool.on('release', () => {
        nextTick(() => knexPool!.client.pool.check())
      })

      // HACK: tarn.js tries to immediately reacquire released resources which prevents them from
      // being released to the external pool. This is the internal function but modified to run
      // the reacquisition attempt in the next process tick which gives the above event listener
      // time to run the idle resource check.
      knexPool.client.pool.release = function release(resource: unknown) {
        this._executeEventHandlers('release', resource)

        for (let i = 0, l = this.used.length; i < l; ++i) {
          const used = this.used[i]

          if (used.resource === resource) {
            this.used.splice(i, 1)
            this.free.push(used.resolve())

            nextTick(() => this._tryAcquireOrCreate())
            return true
          }
        }

        return false
      }
    }

    return new this(knexPool, options)
  }

  protected static sslSettings() {
    if (databaseSSLRootCert) {
      return { ssl: { ca: databaseSSLRootCert } }
    }
    return {}
  }

  async dispose() {
    if (this.options.isExternalPool && isMultitenant) {
      await this.pool.destroy()
    }
  }

  async transaction(instance?: Knex) {
    try {
      const tnx = await retry(
        async (bail) => {
          try {
            const pool = instance || this.pool
            return await pool.transaction()
          } catch (e) {
            if (
              e instanceof DatabaseError &&
              e.code === '08P01' &&
              e.message.includes('no more connections allowed')
            ) {
              throw e
            }

            bail(e as Error)
            return
          }
        },
        {
          minTimeout: 50,
          maxTimeout: 200,
          maxRetryTime: 3000,
          retries: 10,
        }
      )

      if (!tnx) {
        throw ERRORS.InternalError(undefined, 'Could not create transaction')
      }

      if (!instance && this.options.isExternalPool) {
        // Note: in knex there is a bug when using `knex.transaction()` which doesn't bubble up the error to the catch block
        // in case the transaction was not able to be created. This is a workaround to make sure the error is thrown.
        // Ref: https://github.com/knex/knex/issues/4709
        if (tnx.isCompleted()) {
          await tnx.executionPromise

          // This should never be reached, since the above promise is always rejected in this edge case.
          throw ERRORS.DatabaseError('Transaction already completed')
        }

        try {
          await tnx.raw(`SELECT set_config('search_path', ?, true)`, [searchPath.join(', ')])
        } catch (e) {
          await tnx.rollback()
          throw e
        }
      }

      return tnx
    } catch (e) {
      if (e instanceof KnexTimeoutError) {
        throw ERRORS.DatabaseTimeout(e)
      }

      throw e
    }
  }

  transactionProvider(instance?: Knex): Knex.TransactionProvider {
    return async () => {
      return this.transaction(instance)
    }
  }

  asSuperUser() {
    return new TenantConnection(this.pool, {
      ...this.options,
      user: this.options.superUser,
    })
  }

  async setScope(tnx: Knex) {
    const headers = JSON.stringify(this.options.headers || {})
    await tnx.raw(
      `
        SELECT
          set_config('role', ?, true),
          set_config('request.jwt.claim.role', ?, true),
          set_config('request.jwt', ?, true),
          set_config('request.jwt.claim.sub', ?, true),
          set_config('request.jwt.claims', ?, true),
          set_config('request.headers', ?, true),
          set_config('request.method', ?, true),
          set_config('request.path', ?, true),
          set_config('storage.operation', ?, true);
    `,
      [
        this.role,
        this.role,
        this.options.user.jwt || '',
        this.options.user.payload.sub || '',
        JSON.stringify(this.options.user.payload),
        headers,
        this.options.method || '',
        this.options.path || '',
        this.options.operation?.() || '',
      ]
    )
  }
}
