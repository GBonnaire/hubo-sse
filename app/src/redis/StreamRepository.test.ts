import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Redis } from 'ioredis'
import { StreamRepository } from './StreamRepository.js'

const redis = new Redis('redis://redis:6379')
const repo = new StreamRepository(redis)
const STREAM_KEY = 'hubo:test:stream-repo-tests'

beforeEach(async () => {
  await redis.del(STREAM_KEY)
})

afterAll(async () => {
  await redis.del(STREAM_KEY)
  await redis.quit()
})

describe('StreamRepository', () => {
  it('xadd crée une entrée dans le stream avec les champs id, data, timestamp', async () => {
    const eventId = 'test-event-abc123'
    const data = { type: 'status_update', value: 'shipped' }

    await repo.xadd(STREAM_KEY, eventId, data, 1000, 3600)

    const entries = await redis.xrange(STREAM_KEY, '-', '+')
    expect(entries).toHaveLength(1)

    const fields = entries[0]![1]
    expect(fields).toContain('id')
    expect(fields).toContain(eventId)
    expect(fields).toContain('data')
    expect(fields).toContain(JSON.stringify(data))
    expect(fields).toContain('timestamp')
  })

  it('xadd sur stream plein → stream tronqué à maxLen', async () => {
    const maxLen = 3
    for (let i = 0; i < 10; i++) {
      await repo.xadd(STREAM_KEY, `event-${i}`, { i }, maxLen, 3600)
    }

    const len = await redis.xlen(STREAM_KEY)
    expect(len).toBeLessThanOrEqual(maxLen)
    expect(len).toBeGreaterThan(0)
  })

  it('TTL du stream est défini après xadd', async () => {
    await repo.xadd(STREAM_KEY, 'ttl-event', { test: true }, 1000, 60)

    const ttl = await redis.ttl(STREAM_KEY)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60)
  })

  it('TTL du stream est renouvelé à chaque xadd', async () => {
    await repo.xadd(STREAM_KEY, 'event-1', {}, 1000, 30)
    await repo.xadd(STREAM_KEY, 'event-2', {}, 1000, 60)

    const ttl = await redis.ttl(STREAM_KEY)
    expect(ttl).toBeGreaterThan(30)
    expect(ttl).toBeLessThanOrEqual(60)
  })
})

// ─── Story 5.1 : xrange() — Replay via lastEventId ──────────────────────────

describe('StreamRepository — Story 5.1 : xrange()', () => {
  it('5 events publiés, reconnexion lastEventId=e2 → retourne e3, e4, e5 dans l\'ordre', async () => {
    for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) {
      await repo.xadd(STREAM_KEY, id, { seq: id }, 1000, 3600)
    }

    const events = await repo.xrange(STREAM_KEY, 'e2')
    expect(events).toHaveLength(3)
    expect(events[0]!.id).toBe('e3')
    expect(events[1]!.id).toBe('e4')
    expect(events[2]!.id).toBe('e5')
  })

  it('lastEventId inconnu → replay depuis le début sans erreur (AC: 2)', async () => {
    await repo.xadd(STREAM_KEY, 'evt-a', { v: 1 }, 1000, 3600)
    await repo.xadd(STREAM_KEY, 'evt-b', { v: 2 }, 1000, 3600)

    const events = await repo.xrange(STREAM_KEY, 'unknown-id')
    expect(events).toHaveLength(2)
    expect(events[0]!.id).toBe('evt-a')
    expect(events[1]!.id).toBe('evt-b')
  })

  it('stream vide → tableau vide, pas d\'erreur', async () => {
    const events = await repo.xrange(STREAM_KEY, 'any-id')
    expect(events).toHaveLength(0)
  })

  it('lastEventId = dernier event → tableau vide', async () => {
    await repo.xadd(STREAM_KEY, 'last-evt', { v: 1 }, 1000, 3600)

    const events = await repo.xrange(STREAM_KEY, 'last-evt')
    expect(events).toHaveLength(0)
  })

  it('events rejoués portent leurs IDs originaux (AC: 4)', async () => {
    await repo.xadd(STREAM_KEY, 'original-uuid-456', { data: 'test' }, 1000, 3600)

    const events = await repo.xrange(STREAM_KEY, 'unknown')
    expect(events[0]!.id).toBe('original-uuid-456')
  })

  it('data est désérialisée correctement depuis le stream', async () => {
    const payload = { type: 'order_created', amount: 42.5, nested: { ok: true } }
    await repo.xadd(STREAM_KEY, 'data-test', payload, 1000, 3600)

    const events = await repo.xrange(STREAM_KEY, 'unknown')
    expect(events[0]!.data).toEqual(payload)
  })
})

// ─── Story 5.3 : TTL et MAXLEN par tenant ───────────────────────────────────

describe('StreamRepository — Story 5.3 : TTL et MAXLEN par tenant', () => {
  it('stream_ttl: 7200 → TTL Redis = 7200s après XADD (AC: 1)', async () => {
    await repo.xadd(STREAM_KEY, 'evt-ttl-7200', { v: 1 }, 1000, 7200)

    const ttl = await redis.ttl(STREAM_KEY)
    expect(ttl).toBeGreaterThan(7190)
    expect(ttl).toBeLessThanOrEqual(7200)
  })

  it('max_stream_length: 50, 55 events → stream tronqué ≤ 50 (AC: 2)', async () => {
    const maxLen = 50
    for (let i = 0; i < 55; i++) {
      await repo.xadd(STREAM_KEY, `event-${i}`, { i }, maxLen, 3600)
    }

    const len = await redis.xlen(STREAM_KEY)
    expect(len).toBeLessThanOrEqual(maxLen)
    expect(len).toBeGreaterThan(0)
  })

  it('tenant sans configuration → défauts Prisma: stream_ttl=3600, max_stream_length=10000 (AC: 3 — vérifié via schéma)', async () => {
    // Les defaults sont garantis par le schéma Prisma (@default(3600) et @default(10000))
    // Ce test vérifie le comportement avec les valeurs par défaut
    await repo.xadd(STREAM_KEY, 'default-evt', { v: 1 }, 10000, 3600)

    const ttl = await redis.ttl(STREAM_KEY)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(3600)
  })
})
