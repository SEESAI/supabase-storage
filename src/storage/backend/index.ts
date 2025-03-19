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

type ConfigForStorage = {
  s3: S3ClientOptions
  gcs: GCSClientOptions
  file: undefined
}

type Args = {
  [Type in StorageBackendType]: [Type] | [Type, ConfigForStorage[Type]]
}[StorageBackendType]

export function createStorageBackend(...[storageBackendType, config]: Args) {
  if (storageBackendType === 'gcs') {
    return new GCSBackend({
      authConfig: {
        // scope is required when impersonating a service account
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        ...config?.authConfig,
      },
      ...config,
    })
  }

  if (storageBackendType === 's3') {
    const defaultOptions: S3ClientOptions = {
      region: storageS3Region,
      endpoint: storageS3Endpoint,
      forcePathStyle: storageS3ForcePathStyle,
      requestTimeout: storageS3ClientTimeout,
      ...(config ? config : {}),
    }
    return new S3Backend(defaultOptions)
  }

  return new FileBackend()
}
