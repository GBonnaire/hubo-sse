import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../app.js'
import type { AppConfig } from '../config.js'
import { TenantsManager } from '../tenants/TenantsManager.js'

const prisma = new PrismaClient()

const testConfig: AppConfig = {
  port: 3000,
  redis: 'redis://redis:6379',
  database: 'mysql://admin:admin@db:3306/hubo',
  logLevel: 'error',
  httpsRedirect: false,
}

beforeEach(async () => {
  await prisma.tenant.deleteMany()
})

afterAll(async () => {
  await prisma.tenant.deleteMany()
  await prisma.$disconnect()
})

describe('CORS dynamique par tenant', () => {
  it('origine autorisée → header CORS présent', async () => {
    await prisma.tenant.create({
      data: { appId: 'cors-app', secret: 'secret', origins: ['https://allowed.com'] },
    })

    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://allowed.com' },
    })

    expect(res.headers['access-control-allow-origin']).toBe('https://allowed.com')
    await app.close()
  })

  it('origine non autorisée → 403', async () => {
    await prisma.tenant.create({
      data: { appId: 'cors-app2', secret: 'secret', origins: ['https://allowed.com'] },
    })

    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://blocked.com' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })

  it('origins: [] → 403 pour toute origine', async () => {
    await prisma.tenant.create({
      data: { appId: 'cors-app3', secret: 'secret', origins: [] },
    })

    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://any.com' },
    })

    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('requête sans header Origin → traitée normalement', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    const app = await buildApp(testConfig, manager)

    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).not.toBe(403)
    await app.close()
  })
})
