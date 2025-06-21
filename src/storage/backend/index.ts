import { StorageBackendAdapter } from './adapter'
import { FileBackend } from './file'
import { GCSBackend, GCSClientOptions } from './gcs/adapter'
import { S3Backend, S3ClientOptions } from './s3/adapter'
import { getConfig, StorageBackendType } from '../../config'

export * from './s3'
export * from './gcs'
export * from './file'
export * from './adapter'

const { storageS3Region, storageS3Endpoint, storageS3ForcePathStyle, storageS3ClientTimeout } =
  getConfig()

type ConfigForStorage<Type extends StorageBackendType> = Type extends 'file'
  ? undefined
  : Type extends 'gcs'
  ? GCSClientOptions
  : S3ClientOptions

export function createStorageBackend<Type extends StorageBackendType>(
  ...[type, config]: Type extends infer T
    ? T extends Type
      ? [type: T, config: ConfigForStorage<T>]
      : never
    : never
) {
  let storageBackend: StorageBackendAdapter

  if (type === 'file') {
    storageBackend = new FileBackend()
  } else if (type === 'gcs') {
    storageBackend = new GCSBackend({
      authConfig: {
        // scope is required when impersonating a service account
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        ...config?.authConfig,
      },
      ...config,
    })
  } else {
    const defaultOptions: S3ClientOptions = {
      region: storageS3Region,
      endpoint: storageS3Endpoint,
      forcePathStyle: storageS3ForcePathStyle,
      requestTimeout: storageS3ClientTimeout,
      ...(config ? config : {}),
    }
    storageBackend = new S3Backend(defaultOptions)
  }

  return storageBackend
}
