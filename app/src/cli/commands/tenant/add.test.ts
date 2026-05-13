import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

beforeEach(async () => {
  await prisma.tenant.deleteMany({ where: { appId: { startsWith: 'cli-add-test' } } })
})

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { appId: { startsWith: 'cli-add-test' } } })
  await prisma.$disconnect()
})

describe('tenantAddCommand (AC: 1, 2, 3)', () => {
  it('AC1 : crée un tenant avec les champs fournis', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const { tenantAddCommand } = await import('./add.js')
    await tenantAddCommand([
      '--app-id=cli-add-test-1',
      '--secret=my-secret',
      '--origins=https://app.fr',
    ])

    const tenant = await prisma.tenant.findUnique({ where: { appId: 'cli-add-test-1' } })
    expect(tenant).not.toBeNull()
    expect(tenant?.secret).toBe('my-secret')
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("cli-add-test-1"))

    consoleSpy.mockRestore()
  })

  it('AC2 : app_id dupliqué → message erreur correct (P2002)', async () => {
    await prisma.tenant.create({ data: { appId: 'cli-add-test-dup', secret: 'secret' } })

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const { tenantAddCommand } = await import('./add.js')
    await tenantAddCommand(['--app-id=cli-add-test-dup', '--secret=new-secret'])

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('already exists'))
    expect(exitSpy).toHaveBeenCalledWith(1)

    consoleSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('AC3 : plusieurs --origins → tableau d\'origines en DB', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const { tenantAddCommand } = await import('./add.js')
    await tenantAddCommand([
      '--app-id=cli-add-test-origins',
      '--secret=secret',
      '--origins=https://a.fr',
      '--origins=https://b.fr',
    ])

    const tenant = await prisma.tenant.findUnique({ where: { appId: 'cli-add-test-origins' } })
    expect(tenant?.origins).toEqual(['https://a.fr', 'https://b.fr'])

    consoleSpy.mockRestore()
  })
})
