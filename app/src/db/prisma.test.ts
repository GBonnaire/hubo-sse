import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

beforeEach(async () => {
  await prisma.tenant.deleteMany()
})

afterAll(async () => {
  await prisma.tenant.deleteMany()
  await prisma.$disconnect()
})

describe('Tenant model', () => {
  it('crée un tenant avec les défauts appliqués', async () => {
    const tenant = await prisma.tenant.create({
      data: { appId: 'test-app', secret: 'my-secret' },
    })

    expect(tenant.appId).toBe('test-app')
    expect(tenant.algorithm).toBe('HS256')
    expect(tenant.streamTtl).toBe(3600)
    expect(tenant.maxStreamLength).toBe(10000)
    expect(tenant.rateLimitPublish).toBe(100)
    expect(tenant.rateLimitConnections).toBe(500)
    expect(tenant.maxEventSize).toBe(65536)
    expect(tenant.createdAt).toBeInstanceOf(Date)
  })

  it('lève P2002 pour un app_id dupliqué', async () => {
    await prisma.tenant.create({ data: { appId: 'duplicate', secret: 'secret1' } })

    await expect(
      prisma.tenant.create({ data: { appId: 'duplicate', secret: 'secret2' } }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('lève une erreur si le champ secret est manquant', async () => {
    await expect(
      // @ts-expect-error test intentionnel champ requis manquant
      prisma.tenant.create({ data: { appId: 'no-secret' } }),
    ).rejects.toThrow()
  })
})
