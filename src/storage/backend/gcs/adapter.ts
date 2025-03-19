import { Readable } from 'node:stream'
import { URLSearchParams } from 'node:url'

import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import { GoogleAuth, GoogleAuthOptions } from 'google-auth-library'
import { type GaxiosResponse, type RetryConfig } from 'gaxios'
import semaphore from 'p-limit'

import {
  BrowserCacheHeaders,
  ObjectMetadata,
  ObjectResponse,
  paginateList,
  StorageBackendAdapter,
  UploadPart,
  withOptionalVersion,
} from '../adapter'
import { getSignedUrl } from './signer'

export interface GCSClientOptions {
  authClient?: GoogleAuth
  authConfig?: GoogleAuthOptions

  retry?: boolean | RetryConfig
}

export class GCSBackend implements StorageBackendAdapter {
  client: GoogleAuth

  retry: boolean
  retryConfig: RetryConfig

  public constructor(options?: GCSClientOptions) {
    this.client = options?.authClient ?? new GoogleAuth(options?.authConfig)

    this.retry = typeof options?.retry === 'boolean' ? options.retry : true
    this.retryConfig = typeof options?.retry === 'object' ? options.retry : {}
  }

  async list(
    bucketName: string,
    options?: {
      prefix?: string
      delimiter?: string
      nextToken?: string
      startAfter?: string
      beforeDate?: Date
    }
  ): Promise<{ keys: { name: string; size: number }[]; nextToken?: string }> {
    const query = new URLSearchParams([
      ['continuation-token', options?.nextToken ?? ''],
      ['delimiter', options?.delimiter ?? ''],
      ['prefix', options?.prefix ?? ''],
      ['start-after', options?.startAfter ?? ''],
    ])

    for (const key of Array.from(query.keys())) {
      if (!query.get(key)) query.delete(key)
    }

    const url = `https://${bucketName}.storage.googleapis.com/?${query}`

    const response = await this.client.request({
      method: 'GET',
      url,

      responseType: 'text',

      retry: this.retry,
      retryConfig: this.retryConfig,
    })

    if (response.data && response.data.error) {
      throw response.data.error
    }

    const parser = new XMLParser({
      isArray(tagName): boolean {
        return tagName === 'Contents'
      },
    })

    const { ListBucketResult: data } = parser.parse(response.data) as {
      ListBucketResult: {
        Contents: {
          Key: string
          LastModified: string
          Size: number
        }[]
        NextContinuationToken: string | undefined
      }
    }

    const keys = data.Contents?.filter((object) => {
      if (object.LastModified && options?.beforeDate) {
        return new Date(object.LastModified) < options.beforeDate
      } else return true
    }).map((object) => {
      if (options?.prefix) {
        return {
          name: object.Key.replace(options.prefix, '').replace('/', ''),
          size: object.Size,
        }
      }

      return {
        name: object.Key,
        size: object.Size,
      }
    })

    return {
      keys: keys ?? [],
      nextToken: data.NextContinuationToken,
    }
  }

  /**
   * Gets an object body and metadata
   * @param bucketName
   * @param key
   * @param headers
   */
  async getObject(
    bucketName: string,
    key: string,
    version: string | undefined,
    headers?: BrowserCacheHeaders,
    signal?: AbortSignal
  ): Promise<ObjectResponse> {
    const objectName = withOptionalVersion(key, version)
    const url = `https://${bucketName}.storage.googleapis.com/${objectName}`

    const response = await this.client.request({
      method: 'GET',
      signal,
      url,

      headers: {
        'If-Modified-Since': headers?.ifModifiedSince,
        'If-None-Match': headers?.ifNoneMatch,
        Range: headers?.range,
      },

      responseType: 'stream',

      retry: this.retry,
      retryConfig: this.retryConfig,
    })

    if (response.data && response.data.error) {
      throw response.data.error
    }

    return {
      metadata: this.buildMetadata(response),
      httpStatusCode: response.status,
      body: response.data,
    }
  }

  /**
   * Uploads and store an object
   * @param bucketName
   * @param key
   * @param body
   * @param contentType
   * @param cacheControl
   */
  async uploadObject(
    bucketName: string,
    key: string,
    version: string | undefined,
    body: NodeJS.ReadableStream,
    contentType: string,
    cacheControl: string,
    signal?: AbortSignal
  ): Promise<ObjectMetadata> {
    const objectName = withOptionalVersion(key, version)
    const url = `https://${bucketName}.storage.googleapis.com/${objectName}`

    const response = await this.client.request({
      method: 'PUT',
      signal,
      data: body,
      url,

      headers: {
        'Cache-Control': cacheControl,
        'Content-Type': contentType,
      },

      retry: this.retry,
      retryConfig: this.retryConfig,
    })

    if (response.data && response.data.error) {
      throw response.data.error
    }

    const metadata = await this.headObject(bucketName, key, version)
    return metadata
  }

  /**
   * Deletes an object
   * @param bucketName
   * @param key
   * @param version
   */
  async deleteObject(bucketName: string, key: string, version: string | undefined): Promise<void> {
    const objectName = withOptionalVersion(key, version)
    const url = `https://${bucketName}.storage.googleapis.com/${objectName}`

    const response = await this.client.request({
      method: 'DELETE',
      url,

      retry: this.retry,
      retryConfig: this.retryConfig,
    })

    if (response.data && response.data.error) {
      throw response.data.error
    }
  }

  /**
   * Copies an existing object to the given location
   * @param bucketName
   * @param source
   * @param version
   * @param destination
   * @param destinationVersion
   * @param metadata
   * @param conditions
   */
  async copyObject(
    bucketName: string,
    source: string,
    version: string | undefined,
    destination: string,
    destinationVersion: string | undefined,
    metadata?: { cacheControl?: string; mimetype?: string },
    conditions?: {
      ifMatch?: string
      ifNoneMatch?: string
      ifModifiedSince?: Date
      ifUnmodifiedSince?: Date
    }
  ): Promise<Pick<ObjectMetadata, 'httpStatusCode' | 'eTag' | 'lastModified'>> {
    const objectName = withOptionalVersion(destination, destinationVersion)
    const url = `https://${bucketName}.storage.googleapis.com/${objectName}`

    const copySource = `${bucketName}/${withOptionalVersion(source, version)}`

    const response = await this.client.request({
      method: 'PUT',
      url,

      headers: {
        'Cache-Control': metadata?.cacheControl,
        'Content-Type': metadata?.mimetype,
        'X-Goog-Copy-Source': copySource,
        'X-Goog-Copy-Source-If-Match': conditions?.ifMatch,
        'X-Goog-Copy-Source-If-None-Match': conditions?.ifNoneMatch,
        'X-Goog-Copy-Source-If-Unmodified-Since': conditions?.ifUnmodifiedSince?.toUTCString(),
        'X-Goog-Copy-Source-If-Modified-Since': conditions?.ifModifiedSince?.toUTCString(),
        'X-Goog-Metadata-Directive': objectName !== copySource ? 'COPY' : 'REPLACE',
      },

      retry: this.retry,
      retryConfig: this.retryConfig,
    })

    if (response.data && response.data.error) {
      throw response.data.error
    }

    return this.buildMetadata(response)
  }

  /**
   * Deletes multiple objects
   * @param bucketName
   * @param keys
   */
  async deleteObjects(bucketName: string, keys: string[]): Promise<void> {
    const MAX_PARALLEL_LIMIT = 10
    const MAX_QUEUE_SIZE = 1000

    const limit = semaphore(MAX_PARALLEL_LIMIT)
    const queue = []

    for (const key of keys) {
      if (queue.length >= MAX_QUEUE_SIZE) {
        await Promise.all(queue.splice(0))
      }

      queue.push(
        limit(async () => {
          await this.deleteObject(bucketName, key, undefined).catch(() => {
            // ignore
          })
        })
      )
    }

    await Promise.all(queue)
  }

  /**
   * Returns metadata information of a specific object
   * @param bucketName
   * @param key
   * @param version
   */
  async headObject(
    bucketName: string,
    key: string,
    version: string | undefined
  ): Promise<ObjectMetadata> {
    const objectName = withOptionalVersion(key, version)
    const url = `https://${bucketName}.storage.googleapis.com/${objectName}`

    const response = await this.client.request({
      method: 'HEAD',
      url,

      retry: this.retry,
      retryConfig: this.retryConfig,
    })

    if (response.data && response.data.error) {
      throw response.data.error
    }

    return this.buildMetadata(response)
  }

  /**
   * Returns a private url that can only be accessed internally by the system
   * @param bucketName
   * @param key
   * @param version
   */
  async privateAssetUrl(
    bucketName: string,
    key: string,
    version: string | undefined
  ): Promise<string> {
    const objectName = withOptionalVersion(key, version)
    const url = `https://${bucketName}.storage.googleapis.com/${objectName}`

    const request = {
      method: 'GET',
      url,
    }

    return getSignedUrl(this.client, request, {
      expiresIn: 600, // also hardcoded in S3Backend
    })
  }

  async createMultiPartUpload(
    bucketName: string,
    key: string,
    version: string | undefined,
    contentType: string,
    cacheControl: string
  ): Promise<string | undefined> {
    const objectName = withOptionalVersion(key, version)
    const url = `https://${bucketName}.storage.googleapis.com/${objectName}?uploads`

    const response = await this.client.request({
      method: 'POST',
      url,

      headers: {
        'Cache-Control': cacheControl,
        'Content-Type': contentType,
      },

      responseType: 'text',

      retry: this.retry,
      retryConfig: this.retryConfig,
    })

    if (response.data && response.data.error) {
      throw response.data.error
    }

    const parser = new XMLParser({})

    const data = parser.parse(response.data)
    return data.InitiateMultipartUploadResult.UploadId
  }

  async uploadPart(
    bucketName: string,
    key: string,
    version: string,
    uploadId: string,
    partNumber: number,
    body?: string | Uint8Array | Buffer | Readable,
    length?: number,
    signal?: AbortSignal
  ): Promise<{ ETag?: string }> {
    const objectName = withOptionalVersion(key, version)
    const url = `https://${bucketName}.storage.googleapis.com/${objectName}?partNumber=${partNumber}&uploadId=${uploadId}`

    // if (this.checksum === 'md5') {
    //   const buffer = Buffer.from(body ?? '')
    //   const hash = createHash('md5').update(buffer).digest('base64')
    //   headers = {
    //     'Content-MD5': hash,
    //   }
    // }

    const response = await this.client.request({
      method: 'PUT',
      signal,
      body,
      url,

      headers: {
        'Content-Length': length,
      },

      retry: this.retry,
      retryConfig: this.retryConfig,
    })

    if (response.data && response.data.error) {
      throw response.data.error
    }

    return {
      ETag: response.headers['ETag'],
    }
  }

  async completeMultipartUpload(
    bucketName: string,
    key: string,
    uploadId: string,
    version: string,
    parts: UploadPart[]
  ): Promise<
    Omit<UploadPart, 'PartNumber'> & {
      location?: string
      bucket?: string
      version: string
    }
  > {
    const objectName = withOptionalVersion(key, version)
    const url = `https://${bucketName}.storage.googleapis.com/${objectName}?uploadId=${uploadId}`

    const builder = new XMLBuilder({})
    const parser = new XMLParser({})

    const body = builder.build({
      CompleteMultipartUpload: {
        Part: parts,
      },
    })

    const response = await this.client.request({
      method: 'POST',
      body,
      url,

      responseType: 'text',

      retry: this.retry,
      retryConfig: this.retryConfig,
    })

    if (response.data && response.data.error) {
      throw response.data.error
    }

    const data = parser.parse(response.data)

    return {
      ETag: data.CompleteMultipartUploadResult.ETag,
      location: data.CompleteMultipartUploadResult.Location,
      bucket: data.CompleteMultipartUploadResult.Bucket,
      // key: data.CompleteMultipartUploadResult.Key,
      version,
    }
  }

  async abortMultipartUpload(
    bucketName: string,
    key: string,
    uploadId: string,
    version?: string
  ): Promise<void> {
    const objectName = withOptionalVersion(key, version)
    const url = `https://${bucketName}.storage.googleapis.com/${objectName}?uploadId=${uploadId}`

    const response = await this.client.request({
      method: 'DELETE',
      url,

      retry: this.retry,
      retryConfig: this.retryConfig,
    })

    if (response.data && response.data.error) {
      throw response.data.error
    }
  }

  async uploadPartCopy(
    bucketName: string,
    key: string,
    version: string,
    uploadId: string,
    partNumber: number,
    sourceKey: string,
    sourceVersion?: string,
    sourceRange?: { fromByte: number; toByte: number }
  ): Promise<{ eTag?: string; lastModified?: Date }> {
    const objectName = withOptionalVersion(key, version)
    const url = `https://${bucketName}.storage.googleapis.com/${objectName}?partNumber=${partNumber}&uploadId=${uploadId}`

    const copySource = withOptionalVersion(sourceKey, sourceVersion)
    const copyUrl = `https://${bucketName}.storage.googleapis.com/${copySource}`

    const range = sourceRange ? `bytes=${sourceRange.fromByte}-${sourceRange.toByte}` : undefined

    const controller = new AbortController()
    const signal = controller.signal

    const request = await this.client.request({
      method: 'GET',
      url: copyUrl,
      signal,

      headers: {
        Range: range,
      },

      responseType: 'stream',

      retry: this.retry,
      retryConfig: this.retryConfig,
    })

    const body = request.data
    const length = request.headers['Content-Length']

    try {
      const response = await this.client.request({
        method: 'PUT',
        body,
        url,

        headers: {
          'Content-Length': length,
        },

        retry: this.retry,
        retryConfig: this.retryConfig,
      })

      if (response.data && response.data.error) {
        throw response.data.error
      }

      return {
        eTag: response.headers['ETag'],
        lastModified: response.headers['Last-Modified'],
      }
    } catch (reason) {
      controller.abort(reason)
      throw reason
    }
  }

  close(): void {
    // do nothing
  }

  protected buildMetadata(response: GaxiosResponse<unknown>): ObjectMetadata {
    const headers = new Headers(response.headers)

    return {
      cacheControl: headers.get('Cache-Control') || 'no-cache',
      mimetype: headers.get('Content-Type') || 'application/octet-stream',
      eTag: headers.get('ETag') || '',
      lastModified: dateify(headers.get('Last-Modified')),
      contentRange: headers.get('Range') ?? undefined,
      contentLength: Number(headers.get('Content-Length')) || 0,
      size: Number(headers.get('Content-Length')) || 0,
      httpStatusCode: response.status,
    }
  }
}

function dateify(value: string | null): Date | undefined {
  return value !== null ? new Date(value) : undefined
}
