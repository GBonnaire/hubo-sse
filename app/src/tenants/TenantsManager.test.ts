import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { TenantsManager } from './TenantsManager.js'

const prisma = new PrismaClient()

beforeEach(async () => {
  await prisma.tenant.deleteMany()
})

afterAll(async () => {
  await prisma.tenant.deleteMany()
  await prisma.$disconnect()
})

describe('TenantsManager', () => {
  it('load() peuple le cache avec les tenants de la base', async () => {
    await prisma.tenant.create({ data: { appId: 'app1', secret: 'secret1' } })
    await prisma.tenant.create({ data: { appId: 'app2', secret: 'secret2' } })

    const manager = new TenantsManager(prisma)
    await manager.load()

    const t1 = manager.getTenant('app1')
    const t2 = manager.getTenant('app2')
    expect(t1?.appId).toBe('app1')
    expect(t2?.appId).toBe('app2')
  })

  it('getTenant() retourne null pour un app_id inconnu', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()

    expect(manager.getTenant('unknown')).toBeNull()
  })

  it('reload() met à jour le cache avec les changements', async () => {
    const manager = new TenantsManager(prisma)
    await manager.load()
    expect(manager.getTenant('app-reload')).toBeNull()

    await prisma.tenant.create({ data: { appId: 'app-reload', secret: 'secret' } })
    await manager.reload()

    expect(manager.getTenant('app-reload')?.appId).toBe('app-reload')
  })

  it('load() échoue si Prisma lève une erreur', async () => {
    const disconnectedPrisma = new PrismaClient({ datasources: { db: { url: 'mysql://invalid:0/nodb' } } })
    const manager = new TenantsManager(disconnectedPrisma)

    await expect(manager.load()).rejects.toThrow()
    await disconnectedPrisma.$disconnect()
  })
})
