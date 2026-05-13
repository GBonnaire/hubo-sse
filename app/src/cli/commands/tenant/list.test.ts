import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

beforeEach(async () => {
  await prisma.tenant.deleteMany({ where: { appId: { startsWith: 'cli-list-test' } } })
})

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { appId: { startsWith: 'cli-list-test' } } })
  await prisma.$disconnect()
})

describe('tenantListCommand (AC: 1, 2, 3)', () => {
  it('AC3 : aucun tenant → affiche "No tenants configured."', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const { tenantListCommand } = await import('./list.js')
    await tenantListCommand([])

    expect(consoleSpy).toHaveBeenCalledWith('No tenants configured.')
    consoleSpy.mockRestore()
  })

  it('AC1 : tenants en base → console.table appelé', async () => {
    await prisma.tenant.createMany({
      data: [
        { appId: 'cli-list-test-1', secret: 'secret1', origins: ['https://app1.fr'] },
        { appId: 'cli-list-test-2', secret: 'secret2', origins: [] },
      ],
    })

    const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => undefined)

    const { tenantListCommand } = await import('./list.js')
    await tenantListCommand([])

    expect(tableSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ app_id: 'cli-list-test-1' }),
        expect.objectContaining({ app_id: 'cli-list-test-2' }),
      ]),
    )
    tableSpy.mockRestore()
  })

  it('AC2 : --format=json → JSON valide avec [REDACTED]', async () => {
    await prisma.tenant.create({
      data: { appId: 'cli-list-test-json', secret: 'my-secret', origins: ['https://a.fr'] },
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const { tenantListCommand } = await import('./list.js')
    await tenantListCommand(['--format=json'])

    const calls = consoleSpy.mock.calls
    const jsonOutput = calls.find(c => String(c[0]).includes('[REDACTED]'))
    expect(jsonOutput).toBeDefined()

    const parsed = JSON.parse(String(jsonOutput?.[0]))
    const tenant = parsed.find((t: { appId: string }) => t.appId === 'cli-list-test-json')
    expect(tenant?.secret).toBe('[REDACTED]')
    expect(tenant?.appId).toBe('cli-list-test-json')

    consoleSpy.mockRestore()
  })
})
