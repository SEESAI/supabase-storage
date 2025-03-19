import { GoogleAuth } from 'google-auth-library'
import { Buffer } from 'node:buffer'
import { BinaryLike, createHash } from 'node:crypto'
import { URL } from 'node:url'

function sha256(data: BinaryLike): Buffer {
  return createHash('sha256').update(data).digest()
}

function toISOBasicString(this: Date): string {
  return this.toISOString().replace(/\.\d+/, '').replaceAll(/[-:]/g, '')
}

// https://cloud.google.com/storage/docs/authentication/signatures#credential-scope
type CredentialScope = { date: Date; location: string; service: string; requestType: string }

const CredentialScope = {
  toString(data: CredentialScope): string {
    const date = toISOBasicString.call(data.date).slice(0, 8)
    return [date, data.location, data.service, data.requestType].join('/')
  },
}

function hashCanonicalRequest(request: CanonicalRequest): string {
  const headers = new Headers(request.headers)
  const url = new URL(request.url)

  const canonicalQueryString = url.searchParams.toString()

  const canonicalHeaders = Array.from(headers, ([key, value]) => {
    return `${key}:${value.replaceAll(/\s+/g, ' ').trim()}`
  }).join('\n')

  const signedHeaders = Array.from(headers.keys()).join(';')

  const data = [
    request.method,
    url.pathname,
    canonicalQueryString,
    canonicalHeaders + '\n',
    signedHeaders,
    request.data,
  ].join('\n')

  return sha256(data).toString('hex')
}

type StringLike = string | { toString(): string }

interface CanonicalRequest {
  method: string
  url: StringLike

  data?: unknown
  headers?: HeadersInit
}

export interface SigningArguments {
  /**
   * The date and time to be used as signature metadata. This value should be
   * a Date object, a unix (epoch) timestamp, or a string that can be
   * understood by the JavaScript `Date` constructor.If not supplied, the
   * value returned by `new Date()` will be used.
   */
  signingDate?: Date

  signingEndpoint?: StringLike

  /**
   * The service signing name. It will override the service name of the signer
   * in current invocation
   */
  signingService?: string

  /**
   * The region name to sign the request. It will override the signing region of the
   * signer in current invocation
   */
  signingRegion?: string
}

export interface RequestSigningArguments extends SigningArguments {
  /**
   * A set of strings whose members represents headers that cannot be signed.
   * All headers in the provided request will have their names converted to
   * lower case and then checked for existence in the unsignableHeaders set.
   */
  unsignableHeaders?: Set<string>

  /**
   * A set of strings whose members represents headers that should be signed.
   * Any values passed here will override those provided via unsignableHeaders,
   * allowing them to be signed.
   *
   * All headers in the provided request will have their names converted to
   * lower case before signing.
   */
  signableHeaders?: Set<string>
}

/**
 * @public
 */
export interface RequestPresigningArguments extends RequestSigningArguments {
  /**
   * The number of seconds before the presigned URL expires
   */
  expiresIn?: number

  /**
   * A set of strings whose representing headers that should not be hoisted
   * to presigned request's query string. If not supplied, the presigner
   * moves all the AWS-specific headers (starting with `x-amz-`) to the request
   * query string. If supplied, these headers remain in the presigned request's
   * header.
   * All headers in the provided request will have their names converted to
   * lower case and then checked for existence in the unhoistableHeaders set.
   */
  unhoistableHeaders?: Set<string>
}

export async function getSignedUrl(
  client: GoogleAuth,
  request: CanonicalRequest,
  options?: RequestPresigningArguments
): Promise<string> {
  const headers = new Headers(request.headers)
  const url = new URL(request.url)

  if (!headers.has('Host')) {
    headers.set('Host', url.host)
  }

  const unhoistableHeaders = options?.unhoistableHeaders ?? new Set(headers.keys())
  const unsignableHeaders = options?.unsignableHeaders ?? new Set()
  const signableHeaders = options?.signableHeaders ?? new Set()

  for (const [key, value] of Array.from(headers.entries())) {
    if (!unhoistableHeaders.has(key)) {
      url.searchParams.append(key, value)
      headers.delete(key)
    }
  }

  for (const key of headers.keys()) {
    if (unsignableHeaders.has(key) && !signableHeaders.has(key)) {
      headers.delete(key)
    }
  }

  const signingDate = options?.signingDate ?? new Date()
  const expiresIn = options?.expiresIn ?? 900 // default 15 minutes

  if (expiresIn > 604800) {
    throw new RangeError('The longest expiration value is 604800 seconds (7 days)')
  }

  const credentials = await client.getCredentials()
  const credentialScope = CredentialScope.toString({
    date: signingDate,
    location: options?.signingRegion ?? 'auto',
    service: options?.signingService ?? 'storage',
    requestType: 'goog4_request',
  })

  const signingAlgorithm = 'GOOG4-RSA-SHA256'
  const signedHeaders = Array.from(headers.keys()).join(';')

  url.searchParams.append('X-Goog-Algorithm', signingAlgorithm)
  url.searchParams.append('X-Goog-Credential', `${credentials.client_email}/${credentialScope}`)
  url.searchParams.append('X-Goog-Date', toISOBasicString.call(signingDate))
  url.searchParams.append('X-Goog-Expires', expiresIn.toString(10))
  url.searchParams.append('X-Goog-SignedHeaders', signedHeaders)
  url.searchParams.sort()

  const contentHash = headers.get('X-Goog-Content-SHA256') ?? 'UNSIGNED-PAYLOAD'

  const hash = hashCanonicalRequest({
    method: request.method,
    data: contentHash,
    url: url,
    headers,
  })

  // https://cloud.google.com/storage/docs/authentication/signatures#active_datetime
  const activeDatetime = toISOBasicString.call(signingDate)

  // https://cloud.google.com/storage/docs/authentication/signatures#string-to-sign
  const stringToSign = [signingAlgorithm, activeDatetime, credentialScope, hash].join('\n')

  const signature = await client.sign(stringToSign, options?.signingEndpoint?.toString())
  const signatureHex = Buffer.from(signature, 'base64').toString('hex')

  url.searchParams.append('X-Goog-Signature', signatureHex)

  return url.toString()
}
