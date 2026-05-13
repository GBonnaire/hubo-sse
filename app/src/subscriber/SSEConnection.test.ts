import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerResponse } from 'node:http'
import { SSEConnection } from './SSEConnection.js'

function mockResponse() {
  return {
    write: vi.fn<(chunk: string) => boolean>(),
    end: vi.fn<() => void>(),
  }
}

const FAR_FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600

// ─── Story 4.1 : SSEConnection — envoi et format ────────────────────────────

describe('SSEConnection — Story 4.1', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('send() écrit le format SSE correct sur la réponse', () => {
    const res = mockResponse()
    const conn = new SSEConnection(res as unknown as ServerResponse, 'tenant1', FAR_FUTURE_EXP)

    conn.send({ id: 'evt-1', data: { msg: 'hello' } })

    expect(res.write).toHaveBeenCalledWith('id: evt-1\ndata: {"msg":"hello"}\n\n')
  })

  it('send() avec event et retry écrit tous les champs', () => {
    const res = mockResponse()
    const conn = new SSEConnection(res as unknown as ServerResponse, 'tenant1', FAR_FUTURE_EXP)

    conn.send({ id: 'evt-2', data: { v: 1 }, event: 'update', retry: 3000 })

    expect(res.write).toHaveBeenCalledWith('id: evt-2\nevent: update\ndata: {"v":1}\nretry: 3000\n\n')
  })

  it('sendComment() écrit un commentaire SSE (: ...)', () => {
    const res = mockResponse()
    const conn = new SSEConnection(res as unknown as ServerResponse, 'tenant1', FAR_FUTURE_EXP)

    conn.sendComment('ping')

    expect(res.write).toHaveBeenCalledWith(': ping\n\n')
  })

  it('close() appelle response.end()', () => {
    const res = mockResponse()
    const conn = new SSEConnection(res as unknown as ServerResponse, 'tenant1', FAR_FUTURE_EXP)

    conn.close()

    expect(res.end).toHaveBeenCalled()
  })

  it('close() appelé deux fois ne lance pas d\'erreur', () => {
    const res = mockResponse()
    res.end.mockImplementation(() => { throw new Error('already closed') })
    const conn = new SSEConnection(res as unknown as ServerResponse, 'tenant1', FAR_FUTURE_EXP)

    conn.close()
    expect(() => conn.close()).not.toThrow()
  })

  it('id est un UUID généré automatiquement', () => {
    const res = mockResponse()
    const conn = new SSEConnection(res as unknown as ServerResponse, 'tenant1', FAR_FUTURE_EXP)

    expect(conn.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('tenantId est exposé en lecture', () => {
    const res = mockResponse()
    const conn = new SSEConnection(res as unknown as ServerResponse, 'my-tenant', FAR_FUTURE_EXP)

    expect(conn.tenantId).toBe('my-tenant')
  })
})

// ─── Story 4.3 : Heartbeat SSE ──────────────────────────────────────────────

describe('SSEConnection — Story 4.3 : heartbeat', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('envoie ": ping\\n\\n" après 20 secondes sans activité', () => {
    const res = mockResponse()
    new SSEConnection(res as unknown as ServerResponse, 'tenant1', FAR_FUTURE_EXP)

    vi.advanceTimersByTime(20_000)

    expect(res.write).toHaveBeenCalledWith(': ping\n\n')
  })

  it('un événement à 15s réinitialise le timer → ping à 35s', () => {
    const res = mockResponse()
    const conn = new SSEConnection(res as unknown as ServerResponse, 'tenant1', FAR_FUTURE_EXP)

    vi.advanceTimersByTime(15_000)
    conn.send({ id: 'e1', data: {} })
    res.write.mockClear()

    vi.advanceTimersByTime(19_999)
    expect(res.write).not.toHaveBeenCalledWith(': ping\n\n')

    vi.advanceTimersByTime(1)
    expect(res.write).toHaveBeenCalledWith(': ping\n\n')
  })

  it('close() stoppe le heartbeat (pas de fuite de timer)', () => {
    const res = mockResponse()
    const conn = new SSEConnection(res as unknown as ServerResponse, 'tenant1', FAR_FUTURE_EXP)

    conn.close()
    res.write.mockClear()

    vi.advanceTimersByTime(40_000)

    expect(res.write).not.toHaveBeenCalledWith(': ping\n\n')
  })

  it('le commentaire ping n\'est pas un événement de données (pas de champ data:)', () => {
    const res = mockResponse()
    new SSEConnection(res as unknown as ServerResponse, 'tenant1', FAR_FUTURE_EXP)

    vi.advanceTimersByTime(20_000)

    const calls = res.write.mock.calls.map(c => c[0] as string)
    const pingCall = calls.find(c => c.includes('ping'))
    expect(pingCall).toBeDefined()
    expect(pingCall).not.toContain('data:')
    expect(pingCall).not.toContain('event:')
  })
})

// ─── Story 4.4 : Expiration JWT ─────────────────────────────────────────────

describe('SSEConnection — Story 4.4 : expiration JWT', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('envoie token.expired et ferme la connexion à l\'expiration', () => {
    const res = mockResponse()
    const expInMs = Date.now() + 5_000
    const exp = Math.floor(expInMs / 1000)

    new SSEConnection(res as unknown as ServerResponse, 'tenant1', exp)

    vi.advanceTimersByTime(5_001)

    expect(res.write).toHaveBeenCalledWith('event: token.expired\ndata: {}\n\n')
    expect(res.end).toHaveBeenCalled()
  })

  it('fermeture avant expiration → pas d\'envoi token.expired', () => {
    const res = mockResponse()
    const expInMs = Date.now() + 10_000
    const exp = Math.floor(expInMs / 1000)

    const conn = new SSEConnection(res as unknown as ServerResponse, 'tenant1', exp)
    conn.close()

    res.write.mockClear()
    vi.advanceTimersByTime(15_000)

    expect(res.write).not.toHaveBeenCalledWith('event: token.expired\ndata: {}\n\n')
  })

  it('exp déjà passé → sendTokenExpired() appelé via setImmediate', () => {
    const res = mockResponse()
    const expAlreadyPassed = Math.floor(Date.now() / 1000) - 1

    new SSEConnection(res as unknown as ServerResponse, 'tenant1', expAlreadyPassed)

    vi.runAllTimers()

    expect(res.write).toHaveBeenCalledWith('event: token.expired\ndata: {}\n\n')
  })
})
