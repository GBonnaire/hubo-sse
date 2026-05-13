import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../../config.js'
import type { AppConfig } from '../../config.js'

vi.mock('../../config.js', () => ({
  loadConfig: vi.fn(),
}))

vi.mock('../../app.js', () => ({
  buildApp: vi.fn(),
}))

vi.mock('../../tenants/TenantsManager.js', () => ({
  tenantsManager: {
    load: vi.fn().mockResolvedValue(undefined),
    getAllTenants: vi.fn().mockReturnValue([{ appId: 'tenant1' }, { appId: 'tenant2' }]),
    reload: vi.fn().mockResolvedValue(undefined),
  },
}))

import { buildApp } from '../../app.js'
import { tenantsManager } from '../../tenants/TenantsManager.js'

const mockLoadConfig = vi.mocked(loadConfig)
const mockBuildApp = vi.mocked(buildApp)

const fakeConfig: AppConfig = {
  port: 3000,
  redis: 'redis://redis:6379',
  database: 'mysql://admin:admin@db:3306/hubo',
  logLevel: 'info',
  httpsRedirect: false,
}

function makeMockApp(port = 3000) {
  return {
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    listen: vi.fn().mockResolvedValue(`http://0.0.0.0:${port}`),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadConfig.mockReturnValue({ ...fakeConfig })
})

describe('startCommand', () => {
  it('appelle loadConfig sans argument', async () => {
    const mockApp = makeMockApp()
    mockBuildApp.mockResolvedValue(mockApp as never)

    const { startCommand } = await import('./start.js')
    await startCommand({})

    expect(mockLoadConfig).toHaveBeenCalledWith()
  })

  it('--port surcharge le port de la config', async () => {
    const mockApp = makeMockApp(4000)
    mockBuildApp.mockResolvedValue(mockApp as never)

    const { startCommand } = await import('./start.js')
    await startCommand({ port: '4000' })

    expect(mockApp.listen).toHaveBeenCalledWith({ port: 4000, host: '0.0.0.0' })
  })

  it('log de démarrage avec port et nb tenants', async () => {
    const mockApp = makeMockApp()
    mockBuildApp.mockResolvedValue(mockApp as never)

    const { startCommand } = await import('./start.js')
    await startCommand({})

    expect(mockApp.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3000, tenants: 2 }),
      'Hubo started',
    )
  })

  it('buildApp appelé avec tenantsManager et un registry', async () => {
    const mockApp = makeMockApp()
    mockBuildApp.mockResolvedValue(mockApp as never)

    const { startCommand } = await import('./start.js')
    await startCommand({})

    expect(mockBuildApp).toHaveBeenCalledWith(
      expect.any(Object),
      tenantsManager,
      undefined,
      expect.any(Object),
    )
  })
})
