import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { SignJWT } from 'jose'
import { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'
import { TenantsManager } from '../tenants/TenantsManager.js'
import { verifyPublisherJwt, verifySubscriberJwt } from './verifyJwt.js'

const prisma = new PrismaClient()
const SECRET = 'jti-test-secret'

function makeRedis(existsResult: 0 | 1) {
  return { exists: vi.fn().mockResolvedValue(existsResult) } as unknown as Redis & { exists: ReturnType<typeof vi.fn> }
}

async function makeToken(jti?: string, mode = 'publish') {
  const builder = new SignJWT({
    iss: 'jti-test',
    mode,
    topics: ['orders'],
    ...(jti ? { jti } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
  return builder.sign(new TextEncoder().encode(SECRET))
}

beforeAll(async () => {
  await prisma.tenant.deleteMany({ where: { appId: 'jti-test' } })
  await prisma.tenant.create({
    data: { appId: 'jti-test', secret: SECRET, origins: [] },
  })
})

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { appId: 'jti-test' } })
  await prisma.$disconnect()
})

describe('JTI blacklist (AC: 2, 3, 4)', () => {
  it('AC3 : JWT sans JTI → vérification sautée, accès accordé', async () => {
    const token = await makeToken(undefined)
    const manager = new TenantsManager(prisma)
    await manager.load()

    const mockRedis = makeRedis(0)

    const payload = await verifyPublisherJwt(`Bearer ${token}`, manager, mockRedis)
    expect(payload.iss).toBe('jti-test')
    expect(mockRedis.exists).not.toHaveBeenCalled()
  })

  it('AC2 : JTI non révoqué → accès accordé', async () => {
    const token = await makeToken('non-revoked-jti')
    const manager = new TenantsManager(prisma)
    await manager.load()

    const mockRedis = makeRedis(0)

    const payload = await verifyPublisherJwt(`Bearer ${token}`, manager, mockRedis)
    expect(payload.iss).toBe('jti-test')
    expect(mockRedis.exists).toHaveBeenCalledWith('hubo:jti:non-revoked-jti')
  })

  it('AC2 : JTI révoqué → 401 token_revoked (publish)', async () => {
    const token = await makeToken('revoked-jti-pub')
    const manager = new TenantsManager(prisma)
    await manager.load()

    const mockRedis = makeRedis(1)

    await expect(verifyPublisherJwt(`Bearer ${token}`, manager, mockRedis)).rejects.toMatchObject({
      code: 'token_revoked',
      status: 401,
    })
  })

  it('AC2 : JTI révoqué → 401 token_revoked (subscribe)', async () => {
    const token = await makeToken('revoked-jti-sub', 'subscribe')
    const manager = new TenantsManager(prisma)
    await manager.load()

    const mockRedis = makeRedis(1)

    await expect(
      verifySubscriberJwt({ authorization: `Bearer ${token}` }, {}, manager, mockRedis),
    ).rejects.toMatchObject({
      code: 'token_revoked',
      status: 401,
    })
  })
})
