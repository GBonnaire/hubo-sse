import { describe, it, expect, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { SSEConnection } from './SSEConnection.js'
import { SubscriberRegistry } from './SubscriberRegistry.js'

function makeMockResponse() {
  return {
    write: vi.fn(),
    end: vi.fn(),
    writableEnded: false,
  } as unknown as ServerResponse
}

describe('SSEConnection.sendShutdown (AC: 1)', () => {
  it('écrit event server.shutdown puis ferme la connexion', () => {
    const res = makeMockResponse()
    const conn = new SSEConnection(res, 'tenant1', Math.floor(Date.now() / 1000) + 3600)

    conn.sendShutdown()

    expect(res.write).toHaveBeenCalledWith('event: server.shutdown\ndata: {}\n\n')
    expect(res.end).toHaveBeenCalled()
  })
})

describe('SubscriberRegistry.notifyShutdown (AC: 1)', () => {
  it('appelle sendShutdown sur toutes les connexions', () => {
    const registry = new SubscriberRegistry()

    const sendShutdown1 = vi.fn()
    const sendShutdown2 = vi.fn()
    const sendShutdown3 = vi.fn()

    const conn1 = { id: 'c1', tenantId: 't1', send: vi.fn(), sendShutdown: sendShutdown1 }
    const conn2 = { id: 'c2', tenantId: 't1', send: vi.fn(), sendShutdown: sendShutdown2 }
    const conn3 = { id: 'c3', tenantId: 't2', send: vi.fn(), sendShutdown: sendShutdown3 }

    registry.subscribe('t1:orders', conn1)
    registry.subscribe('t1:users', conn2)
    registry.subscribe('t2:events', conn3)

    registry.notifyShutdown()

    expect(sendShutdown1).toHaveBeenCalledOnce()
    expect(sendShutdown2).toHaveBeenCalledOnce()
    expect(sendShutdown3).toHaveBeenCalledOnce()
  })

  it('vide le registre après shutdown', () => {
    const registry = new SubscriberRegistry()
    const conn = { id: 'c1', tenantId: 't1', send: vi.fn(), sendShutdown: vi.fn() }
    registry.subscribe('t1:topic', conn)

    registry.notifyShutdown()

    // Après shutdown, dispatch ne doit rien envoyer
    const sendSpy = vi.fn()
    registry.dispatch('t1:topic', { id: 'e1', data: {} })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('une connexion sur plusieurs topics ne reçoit shutdown qu\'une fois', () => {
    const registry = new SubscriberRegistry()
    const sendShutdown = vi.fn()
    const conn = { id: 'c1', tenantId: 't1', send: vi.fn(), sendShutdown }

    registry.subscribe('t1:topic1', conn)
    registry.subscribe('t1:topic2', conn)
    registry.subscribe('t1:topic3', conn)

    registry.notifyShutdown()

    expect(sendShutdown).toHaveBeenCalledOnce()
  })

  it('fonctionne si les connexions n\'ont pas de sendShutdown (SSEConnection legacy)', () => {
    const registry = new SubscriberRegistry()
    const conn = { id: 'c1', tenantId: 't1', send: vi.fn() } // pas de sendShutdown
    registry.subscribe('t1:topic', conn)

    expect(() => registry.notifyShutdown()).not.toThrow()
  })
})
