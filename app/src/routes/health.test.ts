import { describe, it, expect, vi, beforeEach } from 'vitest'
import { healthHandler } from './health.js'
import type { AppConfig } from '../config.js'
import { ConnectionCounter } from '../subscriber/ConnectionCounter.js'

const testConfig: AppConfig = {
  port: 3000,
  redis: 'redis://redis:6379',
  database: 'mysql://admin:admin@db:3306/hubo',
  logLevel: 'error',
  httpsRedirect: false,
}

vi.mock('../redis/redis.js', () => ({
  getRedis: vi.fn(),
}))

vi.mock('../db/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}))

import { getRedis } from '../redis/redis.js'
import { prisma } from '../db/prisma.js'

const mockGetRedis = vi.mocked(getRedis)
const mockPrisma = vi.mocked(prisma)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('healthHandler', () => {
  it('retourne 200 avec tous les champs quand Redis + MySQL sont OK', async () => {
    mockGetRedis.mockReturnValue({ ping: vi.fn().mockResolvedValue('PONG') } as never)
    mockPrisma.$queryRaw = vi.fn().mockResolvedValue([{ 1: 1 }])

    const result = await healthHandler(testConfig)

    expect(result.status).toBe('ok')
    expect(result.redis).toBe('ok')
    expect(result.database).toBe('ok')
    expect(typeof result.uptime).toBe('number')
    expect(typeof result.connections).toBe('number')
  })

  it('retourne status degraded et redis:error quand Redis KO (timeout)', async () => {
    mockGetRedis.mockReturnValue({
      ping: vi.fn().mockRejectedValue(new Error('Connection refused')),
    } as never)
    mockPrisma.$queryRaw = vi.fn().mockResolvedValue([{ 1: 1 }])

    const result = await healthHandler(testConfig)

    expect(result.status).toBe('degraded')
    expect(result.redis).toBe('error')
    expect(result.database).toBe('ok')
  })

  it('retourne status degraded et database:error quand MySQL KO', async () => {
    mockGetRedis.mockReturnValue({ ping: vi.fn().mockResolvedValue('PONG') } as never)
    mockPrisma.$queryRaw = vi.fn().mockRejectedValue(new Error('Connection failed'))

    const result = await healthHandler(testConfig)

    expect(result.status).toBe('degraded')
    expect(result.redis).toBe('ok')
    expect(result.database).toBe('error')
  })

  it('utilise le compteur de connexions quand fourni', async () => {
    mockGetRedis.mockReturnValue({ ping: vi.fn().mockResolvedValue('PONG') } as never)
    mockPrisma.$queryRaw = vi.fn().mockResolvedValue([{ 1: 1 }])

    const counter = new ConnectionCounter()
    counter.increment('tenant1', undefined, 100)
    counter.increment('tenant1', undefined, 100)
    counter.increment('tenant2', undefined, 100)

    const result = await healthHandler(testConfig, counter)

    expect(result.connections).toBe(3)
  })

  it('retourne connections=0 sans compteur', async () => {
    mockGetRedis.mockReturnValue({ ping: vi.fn().mockResolvedValue('PONG') } as never)
    mockPrisma.$queryRaw = vi.fn().mockResolvedValue([{ 1: 1 }])

    const result = await healthHandler(testConfig)

    expect(result.connections).toBe(0)
  })
})

describe('GET /health via buildApp', () => {
  it("ne requiert pas d'authentification", async () => {
    const { buildApp } = await import('../app.js')
    const app = await buildApp(testConfig)

    mockGetRedis.mockReturnValue({ ping: vi.fn().mockResolvedValue('PONG') } as never)
    mockPrisma.$queryRaw = vi.fn().mockResolvedValue([{ 1: 1 }])

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).not.toBe(401)
    expect(res.statusCode).not.toBe(403)
    await app.close()
  })
})
