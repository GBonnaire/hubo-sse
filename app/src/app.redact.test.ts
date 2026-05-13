import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PassThrough } from 'node:stream'
import { PrismaClient } from '@prisma/client'
import pino from 'pino'
import { buildApp } from './app.js'
import type { AppConfig } from './config.js'
import { TenantsManager } from './tenants/TenantsManager.js'

const prisma = new PrismaClient()

const testConfig: AppConfig = {
  port: 3000,
  redis: 'redis://redis:6379',
  database: 'mysql://admin:admin@db:3306/hubo',
  logLevel: 'info',
  httpsRedirect: false,
}

beforeEach(async () => {
  await prisma.tenant.deleteMany()
})

afterAll(async () => {
  await prisma.tenant.deleteMany()
  await prisma.$disconnect()
})

function buildWithStream(stream: PassThrough, manager?: TenantsManager) {
  const serializers = {
    req(req: { method: string; url?: string }) {
      return {
        method: req.method,
        url: req.url?.replace(/([?&]authorization=)[^&]*/g, '$1[REDACTED]'),
      }
    },
  }
  const logger = pino({
    level: 'info',
    redact: { paths: ['req.headers.authorization', 'req.query.authorization'], censor: '[REDACTED]' },
    serializers,
  }, stream)
  return buildApp(testConfig, manager, logger)
}

describe('Redact données sensibles dans les logs', () => {
  it('GET /subscribe?authorization=secret-token → logs ne contiennent pas le token', async () => {
    const stream = new PassThrough()
    const logs: string[] = []
    stream.on('data', (chunk: Buffer) => logs.push(chunk.toString()))

    const app = await buildWithStream(stream)
    await app.inject({
      method: 'GET',
      url: '/subscribe?topics=test&authorization=super-secret-jwt',
    })
    await app.close()

    expect(logs.join('')).not.toContain('super-secret-jwt')
  })

  it('header Authorization: Bearer secret-token → logs ne contiennent pas le token', async () => {
    const stream = new PassThrough()
    const logs: string[] = []
    stream.on('data', (chunk: Buffer) => logs.push(chunk.toString()))

    const app = await buildWithStream(stream)
    await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: 'Bearer super-secret-header-jwt' },
    })
    await app.close()

    expect(logs.join('')).not.toContain('super-secret-header-jwt')
  })

  it('erreur JWT → log contient reason mais pas le token', async () => {
    await prisma.tenant.create({ data: { appId: 'log-test', secret: 'secret' } })
    const manager = new TenantsManager(prisma)
    await manager.load()

    const stream = new PassThrough()
    const logs: string[] = []
    stream.on('data', (chunk: Buffer) => logs.push(chunk.toString()))

    const logger = pino({ level: 'warn' }, stream)
    const app = await buildApp(testConfig, manager, logger)

    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJsb2ctdGVzdCIsIm1vZGUiOiJwdWJsaXNoIiwidG9waWNzIjpbInRlc3QiXX0.bad-signature-xyz'
    await app.inject({
      method: 'GET',
      url: `/subscribe?authorization=${token}`,
    })
    await app.close()

    expect(logs.join('')).not.toContain(token)
  })
})
