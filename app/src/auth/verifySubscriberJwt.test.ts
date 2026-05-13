import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { SignJWT } from 'jose'
import { TenantsManager } from '../tenants/TenantsManager.js'
import { verifySubscriberJwt, extractSubscriberToken } from './verifyJwt.js'

const prisma = new PrismaClient()
const APP_ID = 'sub-test-app'
const SECRET = 'subscriber-secret-key'

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

describe('extractSubscriberToken', () => {
  it('header prioritaire sur query string quand les deux présents', () => {
    const token = extractSubscriberToken(
      { authorization: 'Bearer header-token' },
      { authorization: 'query-token' },
    )
    expect(token).toBe('header-token')
  })

  it('fallback sur query string si header absent', () => {
    const token = extractSubscriberToken({}, { authorization: 'query-token' })
    expect(token).toBe('query-token')
  })

  it('undefined si ni header ni query', () => {
    const token = extractSubscriberToken({}, {})
    expect(token).toBeUndefined()
  })
})

describe('verifySubscriberJwt', () => {
  it('JWT en query string → autorisé', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    const token = await signToken({ mode: 'subscribe', topics: ['orders'] })
    const payload = await verifySubscriberJwt({}, { authorization: token }, manager)

    expect(payload.mode).toBe('subscribe')
  })

  it('JWT en header → autorisé', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    const token = await signToken({ mode: 'subscribe', topics: ['orders'] })
    const payload = await verifySubscriberJwt(
      { authorization: `Bearer ${token}` },
      {},
      manager,
    )

    expect(payload.mode).toBe('subscribe')
  })

  it('mode publisher → 403 wrong_mode', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    const token = await signToken({ mode: 'publish', topics: ['orders'] })

    await expect(verifySubscriberJwt({}, { authorization: token }, manager))
      .rejects.toMatchObject({ code: 'wrong_mode', status: 403 })
  })

  it('JWT expiré → 401 token_expired', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    const token = await signToken({ mode: 'subscribe', topics: ['orders'] }, '-1s')

    await expect(verifySubscriberJwt({}, { authorization: token }, manager))
      .rejects.toMatchObject({ code: 'token_expired', status: 401 })
  })

  it('absence des deux (header + query) → 401 missing_token', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    await expect(verifySubscriberJwt({}, {}, manager))
      .rejects.toMatchObject({ code: 'missing_token', status: 401 })
  })
})
