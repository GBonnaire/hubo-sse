import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { SignJWT } from 'jose'
import { TenantsManager } from '../tenants/TenantsManager.js'
import { verifyPublisherJwt, AuthError } from './verifyJwt.js'

const prisma = new PrismaClient()
const APP_ID = 'jwt-test-app'
const SECRET = 'super-secret-hs256-key-for-testing'

async function signToken(payload: Record<string, unknown>, expiresIn = '1h'): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setIssuer(APP_ID)
    .sign(new TextEncoder().encode(SECRET))
}

beforeEach(async () => {
  await prisma.tenant.deleteMany()
  await prisma.tenant.create({ data: { appId: APP_ID, secret: SECRET } })
})

afterAll(async () => {
  await prisma.tenant.deleteMany()
  await prisma.$disconnect()
})

describe('verifyPublisherJwt', () => {
  it('JWT HS256 valide + mode publish → autorisé', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    const token = await signToken({ mode: 'publish', topics: ['orders'] })
    const payload = await verifyPublisherJwt(`Bearer ${token}`, manager)

    expect(payload.mode).toBe('publish')
    expect(payload.iss).toBe(APP_ID)
  })

  it('signature invalide → 401 invalid_token', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    const badToken = await new SignJWT({ mode: 'publish', topics: ['orders'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .setIssuer(APP_ID)
      .sign(new TextEncoder().encode('wrong-secret'))

    await expect(verifyPublisherJwt(`Bearer ${badToken}`, manager))
      .rejects.toMatchObject({ code: 'invalid_token', status: 401 })
  })

  it('JWT expiré → 401 token_expired', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    const token = await signToken({ mode: 'publish', topics: ['orders'] }, '-1s')

    await expect(verifyPublisherJwt(`Bearer ${token}`, manager))
      .rejects.toMatchObject({ code: 'token_expired', status: 401 })
  })

  it('mode subscriber → 403 wrong_mode', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    const token = await signToken({ mode: 'subscribe', topics: ['orders'] })

    await expect(verifyPublisherJwt(`Bearer ${token}`, manager))
      .rejects.toMatchObject({ code: 'wrong_mode', status: 403 })
  })

  it('absence header → 401 missing_token', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    await expect(verifyPublisherJwt(undefined, manager))
      .rejects.toMatchObject({ code: 'missing_token', status: 401 })
  })

  it('iss inconnu → 401 unknown_tenant', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    const token = await new SignJWT({ mode: 'publish', topics: ['orders'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .setIssuer('unknown-app')
      .sign(new TextEncoder().encode('any-secret'))

    await expect(verifyPublisherJwt(`Bearer ${token}`, manager))
      .rejects.toMatchObject({ code: 'unknown_tenant', status: 401 })
  })

  it('aucun détail cryptographique dans la réponse d\'erreur', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    try {
      const badToken = await new SignJWT({ mode: 'publish', topics: ['orders'] })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h')
        .setIssuer(APP_ID)
        .sign(new TextEncoder().encode('wrong-secret'))
      await verifyPublisherJwt(`Bearer ${badToken}`, manager)
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError)
      const authErr = err as AuthError
      expect(authErr.message).not.toContain('secret')
      expect(authErr.message).not.toContain('key')
    }
  })
})
