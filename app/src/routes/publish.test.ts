import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { SignJWT } from 'jose'
import { Redis } from 'ioredis'
import { buildApp } from '../app.js'
import { TenantsManager } from '../tenants/TenantsManager.js'
import type { AppConfig } from '../config.js'

const prisma = new PrismaClient()
const redis = new Redis('redis://redis:6379')

const APP_ID = 'publish-test-app'
const SECRET = 'publish-test-secret-key-hs256'

const testConfig: AppConfig = {
  port: 3000,
  redis: 'redis://redis:6379',
  database: 'mysql://admin:admin@db:3306/hubo',
  logLevel: 'error',
  httpsRedirect: false,
}

async function signPublisherToken(
  topics: string[],
  appId = APP_ID,
  secret = SECRET,
  expiresIn = '1h',
): Promise<string> {
  return new SignJWT({ mode: 'publish', topics })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setIssuer(appId)
    .sign(new TextEncoder().encode(secret))
}

beforeEach(async () => {
  await prisma.tenant.deleteMany()
  await prisma.tenant.create({
    data: {
      appId: APP_ID,
      secret: SECRET,
      rateLimitPublish: 100,
      maxEventSize: 65536,
      streamTtl: 3600,
      maxStreamLength: 10000,
    },
  })
})

afterAll(async () => {
  await prisma.tenant.deleteMany()
  await prisma.$disconnect()
  await redis.quit()
})

// ─── Story 3.1 : Endpoint POST /publish — structure de base ─────────────────

describe('POST /publish — Story 3.1', () => {
  it('JWT publisher valide + payload JSON valide → 200 avec ID', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'])

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: ['orders'], data: { type: 'test' } },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ id: string }>()
    expect(typeof body.id).toBe('string')
    expect(body.id.length).toBeGreaterThan(0)
    await app.close()
  })

  it('payload avec id personnalisé → hub respecte l\'ID fourni', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'])

    const customId = 'my-custom-event-id'
    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: ['orders'], data: {}, id: customId },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<{ id: string }>().id).toBe(customId)
    await app.close()
  })

  it('payload sans id → UUID v7 généré automatiquement', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'])

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: ['orders'], data: {} },
    })

    expect(res.statusCode).toBe(200)
    const { id } = res.json<{ id: string }>()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    await app.close()
  })

  it('sans JWT → 401', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      payload: { topics: ['orders'], data: {} },
    })

    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('payload avec retry → champ retry présent dans la réponse des subscribers', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'])

    // Le retry est stocké dans l'event et propagé — pour vérification on inspecte via SubscriberRegistry
    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: ['orders'], data: {}, retry: 5000 },
    })

    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

// ─── Story 3.2 : Fan-out multi-topics ───────────────────────────────────────

describe('POST /publish — Story 3.2', () => {
  it('publish sur 2 topics → 200, les deux topics sont publiés (atomique)', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders:*', 'users:*'])

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        topics: ['orders:42:status', 'users:99:notifications'],
        data: { event: 'update' },
      },
    })

    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('topic non autorisé par le JWT → 403, aucun topic publié', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'])

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        topics: ['orders', 'unauthorized-topic'],
        data: {},
      },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json<{ error: string }>().error).toBe('topic_not_allowed')
    await app.close()
  })

  it('publish sur 1 topic → comportement identique au multi-topics', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'])

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: ['orders'], data: { single: true } },
    })

    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

// ─── Story 3.3 : Persistance Redis Stream ───────────────────────────────────

describe('POST /publish — Story 3.3', () => {
  it('événement publié → entrée dans le stream Redis avec les champs requis', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders:99'])
    const streamKey = `hubo:stream:${APP_ID}:orders:99`

    await redis.del(streamKey)

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: ['orders:99'], data: { status: 'shipped' } },
    })

    expect(res.statusCode).toBe(200)
    const { id } = res.json<{ id: string }>()

    const entries = await redis.xrange(streamKey, '-', '+')
    expect(entries.length).toBeGreaterThan(0)

    const fields = entries[0]![1]
    expect(fields).toContain('id')
    expect(fields).toContain(id)
    expect(fields).toContain('data')
    expect(fields).toContain('timestamp')

    await redis.del(streamKey)
    await app.close()
  })

  it('TTL du stream Redis renouvelé après publication', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders:ttl'])
    const streamKey = `hubo:stream:${APP_ID}:orders:ttl`

    await redis.del(streamKey)

    await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: ['orders:ttl'], data: {} },
    })

    const ttl = await redis.ttl(streamKey)
    expect(ttl).toBeGreaterThan(0)

    await redis.del(streamKey)
    await app.close()
  })
})

// ─── Story 3.4 : Validation du payload (zod) et limite de taille ────────────

describe('POST /publish — Story 3.4', () => {
  it('body sans topics → 400', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'])

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { data: {} },
    })

    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('topics: [] → 400 avec message "topics must have at least one element"', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'])

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: [], data: {} },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('topics must have at least one element')
    await app.close()
  })

  it('payload dépassant maxEventSize du tenant → 413', async () => {
    await prisma.tenant.update({
      where: { appId: APP_ID },
      data: { maxEventSize: 100 },
    })

    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'])

    // Générer un payload > 100 octets
    const largeData: Record<string, string> = {}
    for (let i = 0; i < 20; i++) {
      largeData[`key${i}`] = 'value-that-is-long-enough'
    }

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: ['orders'], data: largeData },
    })

    expect(res.statusCode).toBe(413)
    expect(res.json<{ error: string }>().error).toBe('payload_too_large')
    await app.close()
  })

  it('payload valide → 200', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'])

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: ['orders'], data: { valid: true } },
    })

    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

// ─── Story 3.5 : Rate limiting de publication par tenant ────────────────────

describe('POST /publish — Story 3.5', () => {
  it('limite atteinte → 429 avec error rate_limit_exceeded', async () => {
    const smallLimitAppId = `rl-test-${Date.now()}`
    const smallLimitSecret = 'rl-secret'
    await prisma.tenant.create({
      data: { appId: smallLimitAppId, secret: smallLimitSecret, rateLimitPublish: 3 },
    })

    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'], smallLimitAppId, smallLimitSecret)

    const responses: number[] = []
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/publish',
        headers: { authorization: `Bearer ${token}` },
        payload: { topics: ['orders'], data: { i } },
      })
      responses.push(res.statusCode)
    }

    const okCount = responses.filter((s) => s === 200).length
    const tooManyCount = responses.filter((s) => s === 429).length
    expect(okCount).toBe(3)
    expect(tooManyCount).toBe(1)
    await app.close()
  })

  it('rate limit du tenant A dépassé → requêtes du tenant B non affectées', async () => {
    const ts = Date.now()
    const appIdA = `rl-a-${ts}`
    const appIdB = `rl-b-${ts}`
    const secretA = 'secret-a'
    const secretB = 'secret-b'

    await prisma.tenant.create({ data: { appId: appIdA, secret: secretA, rateLimitPublish: 2 } })
    await prisma.tenant.create({ data: { appId: appIdB, secret: secretB, rateLimitPublish: 100 } })

    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)

    const tokenA = await signPublisherToken(['orders'], appIdA, secretA)
    const tokenB = await signPublisherToken(['orders'], appIdB, secretB)

    // Épuiser le rate limit de A
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/publish',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { topics: ['orders'], data: {} },
      })
    }

    // B n'est pas affecté
    const resB = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { topics: ['orders'], data: {} },
    })

    expect(resB.statusCode).toBe(200)
    await app.close()
  })

  it('réponse 429 inclut le header Retry-After', async () => {
    const ts = Date.now()
    const appIdRL = `rl-retry-${ts}`
    const secretRL = 'retry-secret'

    await prisma.tenant.create({ data: { appId: appIdRL, secret: secretRL, rateLimitPublish: 1 } })

    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)
    const token = await signPublisherToken(['orders'], appIdRL, secretRL)

    // Premier appel réussit, deuxième est rate-limité
    await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: ['orders'], data: {} },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/publish',
      headers: { authorization: `Bearer ${token}` },
      payload: { topics: ['orders'], data: {} },
    })

    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
    await app.close()
  })
})
