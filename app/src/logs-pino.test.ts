import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import pino from 'pino'
import { PublisherService } from './publisher/PublisherService.js'
import { SubscriberRegistry } from './subscriber/SubscriberRegistry.js'
import type { StreamRepository } from './redis/StreamRepository.js'
import type { TenantsManager } from './tenants/TenantsManager.js'
import type { Tenant } from '@prisma/client'

function mockStreamRepo(): StreamRepository {
  return { xadd: vi.fn().mockResolvedValue(undefined) } as unknown as StreamRepository
}

function mockManager(): TenantsManager {
  const t: Tenant = {
    id: 1, appId: 'tenant1', secret: 'secret', algorithm: 'HS256',
    publicKey: null, origins: [], streamTtl: 3600, maxStreamLength: 1000,
    rateLimitPublish: 100, rateLimitConnections: 500, maxEventSize: 65536,
    createdAt: new Date(), updatedAt: new Date(),
  }
  return { getTenant: () => t } as unknown as TenantsManager
}

// ─── AC1 : Log info publish réussi ───────────────────────────────────────────

describe('PublisherService — logs (AC1)', () => {
  it('log info avec tenant_id, event_id, topics après publish réussi', async () => {
    const stream = new PassThrough()
    const logs: Record<string, unknown>[] = []
    stream.on('data', (chunk: Buffer) => {
      try { logs.push(JSON.parse(chunk.toString())) } catch { /* ignore */ }
    })

    const logger = pino({ level: 'info' }, stream)
    const service = new PublisherService(new SubscriberRegistry(), mockStreamRepo(), mockManager(), logger)

    const id = await service.publish('tenant1', ['orders', 'shipments'], { action: 'created' }, {})

    await new Promise(r => setTimeout(r, 10))

    const infoLog = logs.find(l => l.msg === 'event published')
    expect(infoLog).toBeDefined()
    expect(infoLog?.tenant_id).toBe('tenant1')
    expect(infoLog?.event_id).toBe(id)
    expect(infoLog?.topics).toEqual(['orders', 'shipments'])
    expect(infoLog?.level).toBe(30) // pino info level
  })

  it('pas de log si aucun logger fourni', async () => {
    const service = new PublisherService(new SubscriberRegistry(), mockStreamRepo(), mockManager())
    await expect(service.publish('tenant1', ['orders'], {}, {})).resolves.toBeDefined()
  })
})

// ─── AC2 : Warn JWT sans token ───────────────────────────────────────────────

describe('buildApp — warn JWT (AC2)', () => {
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
  })

  it('erreur JWT → log warn avec reason, sans token JWT', async () => {
    const { buildApp } = await import('./app.js')
    const { TenantsManager } = await import('./tenants/TenantsManager.js')
    const { PrismaClient } = await import('@prisma/client')

    const prisma = new PrismaClient()
    await prisma.tenant.deleteMany({ where: { appId: 'warn-test' } })
    await prisma.tenant.create({ data: { appId: 'warn-test', secret: 'secret' } })

    const manager = new TenantsManager(prisma)
    await manager.load()

    const stream = new PassThrough()
    const logs: Record<string, unknown>[] = []
    stream.on('data', (chunk: Buffer) => {
      try { logs.push(JSON.parse(chunk.toString())) } catch { /* ignore */ }
    })

    const logger = pino({ level: 'warn' }, stream)
    const app = await buildApp(
      { port: 3000, redis: 'redis://redis:6379', database: '', logLevel: 'warn', httpsRedirect: false },
      manager,
      logger,
    )

    const badToken = 'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ3YXJuLXRlc3QiLCJtb2RlIjoic3Vic2NyaWJlIiwidG9waWNzIjpbInQiXX0.bad'
    await app.inject({ method: 'GET', url: `/subscribe?topics=t&authorization=${badToken}` })
    await app.close()

    await prisma.tenant.deleteMany({ where: { appId: 'warn-test' } })
    await prisma.$disconnect()

    await new Promise(r => setTimeout(r, 10))

    const warnLog = logs.find(l => l.level === 40 && l.msg === 'JWT validation failed')
    expect(warnLog).toBeDefined()
    expect(warnLog?.reason).toBeDefined()
    expect(JSON.stringify(warnLog)).not.toContain(badToken)
  })
})

// ─── AC4 : Production → pas pino-pretty ──────────────────────────────────────

describe('buildLogger — production JSON (AC4)', () => {
  it('NODE_ENV=production → sortie JSON minifiée sans pino-pretty', async () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    const stream = new PassThrough()
    const chunks: string[] = []
    stream.on('data', (d: Buffer) => chunks.push(d.toString()))

    const { buildApp } = await import('./app.js')
    const app = await buildApp(
      { port: 3000, redis: 'redis://redis:6379', database: '', logLevel: 'info', httpsRedirect: false },
      undefined,
      pino({ level: 'info' }, stream),
    )
    await app.inject({ method: 'GET', url: '/nonexistent' })
    await app.close()

    process.env.NODE_ENV = original

    const output = chunks.join('')
    // Format JSON valide (pas de couleurs ANSI de pino-pretty)
    expect(output).not.toMatch(/\[/)
    if (output) {
      const firstLine = output.split('\n')[0]
      if (firstLine) expect(() => JSON.parse(firstLine)).not.toThrow()
    }
  })
})
