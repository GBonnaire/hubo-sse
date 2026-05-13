import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { TenantsManager } from '../../../tenants/TenantsManager.js'

const prisma = new PrismaClient()

beforeEach(async () => {
  await prisma.tenant.deleteMany({ where: { appId: { startsWith: 'cli-rm-test' } } })
})

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { appId: { startsWith: 'cli-rm-test' } } })
  await prisma.$disconnect()
})

describe('tenantRemoveCommand (AC: 1, 2, 3)', () => {
  it('AC1 : supprime le tenant de la DB', async () => {
    await prisma.tenant.create({ data: { appId: 'cli-rm-test-1', secret: 'secret' } })
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const { tenantRemoveCommand } = await import('./remove.js')
    await tenantRemoveCommand(['--app-id=cli-rm-test-1'])

    const found = await prisma.tenant.findUnique({ where: { appId: 'cli-rm-test-1' } })
    expect(found).toBeNull()
    expect(consoleSpy).toHaveBeenCalledWith("Tenant 'cli-rm-test-1' removed successfully.")
    consoleSpy.mockRestore()
  })

  it('AC3 : app_id inexistant → erreur "not found" + exit 1', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const { tenantRemoveCommand } = await import('./remove.js')
    await tenantRemoveCommand(['--app-id=cli-rm-test-ghost'])

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not found'))
    expect(exitSpy).toHaveBeenCalledWith(1)
    consoleSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('AC1 : après suppression, TenantsManager rechargé → getTenant retourne null', async () => {
    await prisma.tenant.create({ data: { appId: 'cli-rm-test-cache', secret: 'secret' } })
    const manager = new TenantsManager(prisma)
    await manager.load()
    expect(manager.getTenant('cli-rm-test-cache')).not.toBeNull()

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { tenantRemoveCommand } = await import('./remove.js')
    await tenantRemoveCommand(['--app-id=cli-rm-test-cache'])

    await manager.reload()
    expect(manager.getTenant('cli-rm-test-cache')).toBeNull()
    consoleSpy.mockRestore()
  })
})
