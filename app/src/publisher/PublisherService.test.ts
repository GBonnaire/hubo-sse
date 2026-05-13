import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PublisherService } from './PublisherService.js'
import { SubscriberRegistry } from '../subscriber/SubscriberRegistry.js'
import type { SSEConnection, SSEEvent } from '../subscriber/SubscriberRegistry.js'
import type { StreamRepository } from '../redis/StreamRepository.js'
import type { TenantsManager } from '../tenants/TenantsManager.js'
import type { Tenant } from '@prisma/client'

function mockConn(id: string): SSEConnection & { send: ReturnType<typeof vi.fn<(e: SSEEvent) => void>> } {
  const send = vi.fn<(e: SSEEvent) => void>()
  return { id, tenantId: 'test-app', send }
}

function mockStreamRepo(): StreamRepository {
  return { xadd: vi.fn().mockResolvedValue(undefined) } as unknown as StreamRepository
}

function mockManager(tenant: Partial<Tenant> | null = {}): TenantsManager {
  const t = tenant === null ? null : {
    id: 1,
    appId: 'test-app',
    secret: 'secret',
    algorithm: 'HS256',
    publicKey: null,
    origins: [],
    streamTtl: 3600,
    maxStreamLength: 1000,
    rateLimitPublish: 100,
    rateLimitConnections: 500,
    maxEventSize: 65536,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...tenant,
  } satisfies Tenant
  return { getTenant: () => t } as unknown as TenantsManager
}

describe('PublisherService', () => {
  let registry: SubscriberRegistry
  let streamRepo: ReturnType<typeof mockStreamRepo>
  let manager: TenantsManager

  beforeEach(() => {
    registry = new SubscriberRegistry()
    streamRepo = mockStreamRepo()
    manager = mockManager()
  })

  it('publish retourne un eventId string', async () => {
    const service = new PublisherService(registry, streamRepo, manager)
    const id = await service.publish('test-app', ['orders'], { action: 'test' }, {})
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('publish avec id fourni → retourne le même id', async () => {
    const service = new PublisherService(registry, streamRepo, manager)
    const customId = 'my-custom-id'
    const id = await service.publish('test-app', ['orders'], {}, { id: customId })
    expect(id).toBe(customId)
  })

  it('publish génère un UUID v7 si id absent', async () => {
    const service = new PublisherService(registry, streamRepo, manager)
    const id = await service.publish('test-app', ['orders'], {}, {})
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('publish sur 2 topics → 2 subscribers (un par topic) reçoivent l\'événement', async () => {
    const service = new PublisherService(registry, streamRepo, manager)
    const conn1 = mockConn('c1')
    const conn2 = mockConn('c2')

    registry.subscribe('test-app:orders:42:status', conn1)
    registry.subscribe('test-app:users:99:notifications', conn2)

    await service.publish(
      'test-app',
      ['orders:42:status', 'users:99:notifications'],
      { event: 'update' },
      {},
    )

    expect(conn1.send).toHaveBeenCalledOnce()
    expect(conn2.send).toHaveBeenCalledOnce()

    const event1 = conn1.send.mock.calls[0]?.[0]
    const event2 = conn2.send.mock.calls[0]?.[0]
    expect(event1?.id).toBe(event2?.id)
  })

  it('publish sur 1 topic → seul le subscriber de ce topic reçoit', async () => {
    const service = new PublisherService(registry, streamRepo, manager)
    const conn1 = mockConn('c1')
    const conn2 = mockConn('c2')

    registry.subscribe('test-app:orders', conn1)
    registry.subscribe('test-app:other', conn2)

    await service.publish('test-app', ['orders'], {}, {})

    expect(conn1.send).toHaveBeenCalledOnce()
    expect(conn2.send).not.toHaveBeenCalled()
  })

  it('publish appelle xadd pour chaque topic quand tenant existant', async () => {
    const service = new PublisherService(registry, streamRepo, manager)

    await service.publish('test-app', ['orders', 'notifications'], { data: 1 }, {})

    expect(streamRepo.xadd).toHaveBeenCalledTimes(2)
  })

  it('publish avec retry → event envoyé aux subscribers avec retry', async () => {
    const service = new PublisherService(registry, streamRepo, manager)
    const conn = mockConn('c1')
    registry.subscribe('test-app:orders', conn)

    await service.publish('test-app', ['orders'], {}, { retry: 5000 })

    const event = conn.send.mock.calls[0]?.[0]
    expect(event?.retry).toBe(5000)
  })

  it('publish sans tenant trouvé → xadd non appelé, dispatch quand même', async () => {
    const noTenantManager = mockManager(null)
    const service = new PublisherService(registry, streamRepo, noTenantManager)
    const conn = mockConn('c1')
    registry.subscribe('unknown:orders', conn)

    await service.publish('unknown', ['orders'], {}, {})

    expect(streamRepo.xadd).not.toHaveBeenCalled()
    expect(conn.send).toHaveBeenCalledOnce()
  })
})

// ─── Story 5.3 : Configuration TTL et MAXLEN par tenant ─────────────────────

describe('PublisherService — Story 5.3 : TTL et MAXLEN par tenant', () => {
  let registry: SubscriberRegistry
  let streamRepo: ReturnType<typeof mockStreamRepo>

  beforeEach(() => {
    registry = new SubscriberRegistry()
    streamRepo = mockStreamRepo()
  })

  it('stream_ttl: 7200 → xadd appelé avec ttlSeconds=7200 (AC: 1)', async () => {
    const manager = mockManager({ streamTtl: 7200, maxStreamLength: 10000 })
    const service = new PublisherService(registry, streamRepo, manager)

    await service.publish('test-app', ['orders'], {}, {})

    expect(streamRepo.xadd).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      10000,
      7200,
    )
  })

  it('max_stream_length: 5000 → xadd appelé avec maxLen=5000 (AC: 2)', async () => {
    const manager = mockManager({ streamTtl: 3600, maxStreamLength: 5000 })
    const service = new PublisherService(registry, streamRepo, manager)

    await service.publish('test-app', ['orders'], {}, {})

    expect(streamRepo.xadd).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      5000,
      3600,
    )
  })

  it('tenant sans config → défauts Prisma: streamTtl=3600, maxStreamLength=10000 (AC: 3)', async () => {
    const manager = mockManager({ streamTtl: 3600, maxStreamLength: 10000 })
    const service = new PublisherService(registry, streamRepo, manager)

    await service.publish('test-app', ['orders'], {}, {})

    expect(streamRepo.xadd).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      10000,
      3600,
    )
  })
})
