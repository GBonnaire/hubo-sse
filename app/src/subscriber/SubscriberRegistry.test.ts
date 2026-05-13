import { describe, it, expect, vi } from 'vitest'
import { SubscriberRegistry } from './SubscriberRegistry.js'
import type { SSEConnection, SSEEvent } from './SubscriberRegistry.js'

function mockConnection(id: string, tenantId: string): SSEConnection & { send: ReturnType<typeof vi.fn<(e: SSEEvent) => void>> } {
  const send = vi.fn<(e: SSEEvent) => void>()
  return { id, tenantId, send }
}

describe('SubscriberRegistry', () => {
  it('dispatch envoie l\'événement à la connexion abonnée', () => {
    const registry = new SubscriberRegistry()
    const conn = mockConnection('c1', 'tenant1')
    const event: SSEEvent = { id: 'evt-1', data: { msg: 'hello' } }

    registry.subscribe('tenant1:orders', conn)
    registry.dispatch('tenant1:orders', event)

    expect(conn.send).toHaveBeenCalledWith(event)
  })

  it('dispatch envoie aux connexions des deux topics différents', () => {
    const registry = new SubscriberRegistry()
    const conn1 = mockConnection('c1', 'tenant1')
    const conn2 = mockConnection('c2', 'tenant1')
    const event: SSEEvent = { id: 'evt-1', data: {} }

    registry.subscribe('tenant1:topic-a', conn1)
    registry.subscribe('tenant1:topic-b', conn2)

    registry.dispatch('tenant1:topic-a', event)
    registry.dispatch('tenant1:topic-b', event)

    expect(conn1.send).toHaveBeenCalledWith(event)
    expect(conn2.send).toHaveBeenCalledWith(event)
  })

  it('dispatch ne touche pas les autres topics', () => {
    const registry = new SubscriberRegistry()
    const connA = mockConnection('c1', 'tenant1')
    const connB = mockConnection('c2', 'tenant1')
    const event: SSEEvent = { id: 'evt-1', data: {} }

    registry.subscribe('tenant1:topic-a', connA)
    registry.subscribe('tenant1:topic-b', connB)

    registry.dispatch('tenant1:topic-a', event)

    expect(connA.send).toHaveBeenCalledOnce()
    expect(connB.send).not.toHaveBeenCalled()
  })

  it('dispatch ne fait rien si aucun subscriber', () => {
    const registry = new SubscriberRegistry()
    expect(() => registry.dispatch('tenant1:empty', { id: 'e1', data: {} })).not.toThrow()
  })

  it('unsubscribe retire la connexion : dispatch ne l\'atteint plus', () => {
    const registry = new SubscriberRegistry()
    const conn = mockConnection('c1', 'tenant1')

    registry.subscribe('tenant1:orders', conn)
    registry.unsubscribe('tenant1:orders', conn)
    registry.dispatch('tenant1:orders', { id: 'e1', data: {} })

    expect(conn.send).not.toHaveBeenCalled()
  })

  it('publish sur 1 topic → subscriber reçoit l\'événement', () => {
    const registry = new SubscriberRegistry()
    const conn = mockConnection('c1', 'tenant1')
    const event: SSEEvent = { id: 'single-1', data: { v: 1 } }

    registry.subscribe('tenant1:orders:42:status', conn)
    registry.dispatch('tenant1:orders:42:status', event)

    expect(conn.send).toHaveBeenCalledWith(event)
  })
})
