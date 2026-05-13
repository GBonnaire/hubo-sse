import { jwtVerify, decodeJwt, importSPKI, errors as JoseErrors } from 'jose'
import type { Redis } from 'ioredis'
import type { TenantsManager } from '../tenants/TenantsManager.js'
import type { Tenant } from '@prisma/client'

/** Claims attendus dans tous les JWT Hubo. */
export interface HuboJwtPayload {
  iss: string
  mode: 'publish' | 'subscribe'
  topics: string[]
  exp: number
  jti?: string
  session_id?: string
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly tenantId?: string,
  ) {
    super(code)
  }
}

/** Résout la clé de vérification selon l'algorithme configuré sur le tenant. */
async function resolveKey(tenant: Tenant): Promise<CryptoKey | Uint8Array> {
  if (tenant.algorithm === 'RS256') {
    if (!tenant.publicKey) throw new AuthError('invalid_token', 401, tenant.appId)
    return importSPKI(tenant.publicKey, 'RS256')
  }
  return new TextEncoder().encode(tenant.secret)
}

/**
 * Vérifie un token JWT brut (sans contrôle du claim `mode`).
 *
 * Étapes :
 * 1. Décode sans vérification pour extraire `iss` et identifier le tenant.
 * 2. Vérifie la signature avec la clé du tenant (HS256 ou RS256).
 * 3. Vérifie que le JTI n'est pas révoqué dans Redis (si `jti` présent et `redis` fourni).
 *
 * @throws {AuthError} `missing_token` | `invalid_token` | `token_expired` |
 *                     `unknown_tenant` | `token_revoked`
 */
async function coreVerify(
  token: string,
  manager: TenantsManager,
  redis?: Redis,
): Promise<HuboJwtPayload> {
  let rawIss: string | undefined
  try {
    rawIss = decodeJwt(token).iss
  } catch {
    throw new AuthError('invalid_token', 401)
  }

  const tenant = manager.getTenant(rawIss ?? '')
  if (!tenant) throw new AuthError('unknown_tenant', 401)

  const key = await resolveKey(tenant)
  const algorithms = tenant.algorithm === 'RS256' ? ['RS256' as const] : ['HS256' as const]

  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(token, key, { algorithms })
    payload = result.payload as Record<string, unknown>
  } catch (err) {
    if (err instanceof AuthError) throw err
    if (err instanceof JoseErrors.JWTExpired) throw new AuthError('token_expired', 401, rawIss)
    throw new AuthError('invalid_token', 401, rawIss)
  }

  const typed = payload as unknown as HuboJwtPayload

  if (typed.jti && redis) {
    const revoked = await redis.exists(`hubo:jti:${typed.jti}`)
    if (revoked) throw new AuthError('token_revoked', 401, rawIss)
  }

  return typed
}

/**
 * Vérifie un JWT publisher transmis dans le header `Authorization: Bearer <token>`.
 * @throws {AuthError} `missing_token` | `wrong_mode` | voir {@link coreVerify}
 */
export async function verifyPublisherJwt(
  authHeader: string | undefined,
  manager: TenantsManager,
  redis?: Redis,
): Promise<HuboJwtPayload> {
  if (!authHeader?.startsWith('Bearer ')) throw new AuthError('missing_token', 401)
  const token = authHeader.slice(7)
  const payload = await coreVerify(token, manager, redis)
  if (payload.mode !== 'publish') throw new AuthError('wrong_mode', 403, payload.iss)
  return payload
}

/**
 * Vérifie un JWT subscriber transmis via header `Authorization` ou query `?authorization=`.
 * @throws {AuthError} `missing_token` | `wrong_mode` | voir {@link coreVerify}
 */
export async function verifySubscriberJwt(
  headers: { authorization?: string | undefined },
  query: { authorization?: string | undefined },
  manager: TenantsManager,
  redis?: Redis,
): Promise<HuboJwtPayload> {
  const token = extractSubscriberToken(headers, query)
  if (!token) throw new AuthError('missing_token', 401)
  const payload = await coreVerify(token, manager, redis)
  if (payload.mode !== 'subscribe') throw new AuthError('wrong_mode', 403, payload.iss)
  return payload
}

/**
 * Extrait le token brut depuis le header `Authorization` (prioritaire)
 * ou le query param `authorization`.
 */
export function extractSubscriberToken(
  headers: { authorization?: string | undefined },
  query: { authorization?: string | undefined },
): string | undefined {
  if (headers.authorization?.startsWith('Bearer ')) return headers.authorization.slice(7)
  return query.authorization
}
