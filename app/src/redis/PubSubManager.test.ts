import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PubSubManager } from './PubSubManager.js'
import { SubscriberRegistry } from '../subscriber/SubscriberRegistry.js'

function makeRedis() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  return {
    psubscribe: vi.fn().mockResolvedValue(undefined),
    punsubscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
    }),
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
  }
}

describe('PubSubManager (AC: 1, 2, 3)', () => {
  let registry: SubscriberRegistry

  beforeEach(() => {
    registry = new SubscriberRegistry()
  })

  it('AC2 : subscribe sur le pattern hubo:pubsub:* au démarrage', async () => {
    const redis = makeRedis()
    const mgr = new PubSubManager(redis as never, registry)
    await mgr.start()
    expect(redis.psubscribe).toHaveBeenCalledWith('hubo:pubsub:*')
  })

  it('AC1 : message Pub/Sub → dispatché aux connexions locales', async () => {
    const redis = makeRedis()
    const mgr = new PubSubManager(redis as never, registry)
    await mgr.start()

    const sendSpy = vi.fn()
    const conn = { id: 'c1', tenantId: 'app1', send: sendSpy, sendShutdown: vi.fn() }
    registry.subscribe('app1:orders', conn)

    redis.emit('pmessage', 'hubo:pubsub:*', 'hubo:pubsub:app1:orders', JSON.stringify({
      id: 'evt-1',
      data: { action: 'created' },
    }))

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt-1' }))
  })

  it('AC3 : message malformé → ignoré sans crash', async () => {
    const redis = makeRedis()
    const mgr = new PubSubManager(redis as never, registry)
    await mgr.start()

    expect(() => redis.emit('pmessage', 'hubo:pubsub:*', 'hubo:pubsub:app1:orders', 'invalid-json')).not.toThrow()
  })

  it('canal invalide → ignoré', async () => {
    const redis = makeRedis()
    const mgr = new PubSubManager(redis as never, registry)
    await mgr.start()

    const sendSpy = vi.fn()
    const conn = { id: 'c1', tenantId: 'app1', send: sendSpy }
    registry.subscribe('app1:orders', conn)

    // Canal sans assez de parties
    redis.emit('pmessage', 'hubo:pubsub:*', 'short', JSON.stringify({ id: 'e1', data: {} }))
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('stop → punsubscribe appelé', async () => {
    const redis = makeRedis()
    const mgr = new PubSubManager(redis as never, registry)
    await mgr.start()
    await mgr.stop()
    expect(redis.punsubscribe).toHaveBeenCalledWith('hubo:pubsub:*')
  })
})
