import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { SignJWT } from 'jose'
import Fastify from 'fastify'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { Redis } from 'ioredis'
import { TenantsManager } from '../tenants/TenantsManager.js'
import { SubscriberRegistry } from '../subscriber/SubscriberRegistry.js'
import { ConnectionCounter } from '../subscriber/ConnectionCounter.js'
import { StreamRepository } from '../redis/StreamRepository.js'
import { subscribeRoutes, parseTopics, resolveLastEventId } from './subscribe.js'

const prisma = new PrismaClient()
const APP_ID = 'sub-route-test-app'
const SECRET = 'sub-route-test-secret'
const redis = new Redis('redis://redis:6379')
const streamRepo = new StreamRepository(redis)

async function signToken(
  topics: string[],
  opts: { expiresIn?: string; mode?: string; sessionId?: string } = {},
): Promise<string> {
  const { expiresIn = '1h', mode = 'subscribe', sessionId } = opts
  const payload: Record<string, unknown> = { mode, topics }
  if (sessionId) payload['session_id'] = sessionId
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setIssuer(APP_ID)
    .sign(new TextEncoder().encode(SECRET))
}

async function buildTestApp(counter?: ConnectionCounter, repo?: StreamRepository) {
  const manager = new TenantsManager(prisma)
  await manager.load()
  const registry = new SubscriberRegistry()
  const cntr = counter ?? new ConnectionCounter()
  const app = Fastify({ logger: false })
  const opts = { manager, registry, counter: cntr, ...(repo !== undefined ? { streamRepo: repo } : {}) }
  await app.register(subscribeRoutes, opts)
  await app.ready()
  return { app, manager, registry, counter: cntr }
}

beforeEach(async () => {
  await prisma.tenant.deleteMany()
  await prisma.tenant.create({
    data: { appId: APP_ID, secret: SECRET, rateLimitConnections: 500 },
  })
})

afterAll(async () => {
  await prisma.tenant.deleteMany()
  await prisma.$disconnect()
  await redis.quit()
})

// ─── Utilitaire parseTopics ──────────────────────────────────────────────────

describe('parseTopics', () => {
  it('undefined → tableau vide', () => {
    expect(parseTopics(undefined)).toEqual([])
  })

  it('chaîne simple → un topic', () => {
    expect(parseTopics('orders')).toEqual(['orders'])
  })

  it('CSV → plusieurs topics', () => {
    expect(parseTopics('orders,users')).toEqual(['orders', 'users'])
  })

  it('tableau de strings → multi-topics', () => {
    expect(parseTopics(['orders', 'users'])).toEqual(['orders', 'users'])
  })

  it('tableau avec CSV imbriqué → aplati', () => {
    expect(parseTopics(['orders:42,users:99', 'notif'])).toEqual(['orders:42', 'users:99', 'notif'])
  })

  it('déduplique les topics', () => {
    expect(parseTopics(['orders', 'orders'])).toEqual(['orders'])
  })

  it('espaces autour des topics → trimés', () => {
    expect(parseTopics('orders , users')).toEqual(['orders', 'users'])
  })
})

// ─── Story 5.2 : resolveLastEventId ─────────────────────────────────────────

describe('resolveLastEventId — Story 5.2', () => {
  it('header Last-Event-ID seul → retourne la valeur du header', () => {
    expect(resolveLastEventId({ 'last-event-id': 'abc-123' }, {})).toBe('abc-123')
  })

  it('query param seul → retourne la valeur du query param', () => {
    expect(resolveLastEventId({}, { lastEventId: 'xyz-789' })).toBe('xyz-789')
  })

  it('header ET query param → header a la priorité (AC: 2)', () => {
    expect(
      resolveLastEventId({ 'last-event-id': 'header-val' }, { lastEventId: 'query-val' })
    ).toBe('header-val')
  })

  it('aucun des deux → retourne undefined', () => {
    expect(resolveLastEventId({}, {})).toBeUndefined()
  })
})

// ─── Story 4.1 : Auth et réponse de base ────────────────────────────────────

describe('GET /subscribe — Story 4.1 : auth', () => {
  afterEach(async () => {
    // les apps sont fermées dans chaque test
  })

  it('sans JWT → 401 missing_token', async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/subscribe?topics=orders' })
    expect(res.statusCode).toBe(401)
    expect(res.json<{ error: string }>().error).toBe('missing_token')
    await app.close()
  })

  it('JWT publisher utilisé pour subscribe → 403 wrong_mode', async () => {
    const { app } = await buildTestApp()
    const token = await signToken(['orders'], { mode: 'publish' })
    const res = await app.inject({
      method: 'GET',
      url: `/subscribe?topics=orders&authorization=${token}`,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ error: string }>().error).toBe('wrong_mode')
    await app.close()
  })

  it('sans topics dans la query → 400 topics_required', async () => {
    const { app } = await buildTestApp()
    const token = await signToken(['orders'])
    const res = await app.inject({
      method: 'GET',
      url: `/subscribe?authorization=${token}`,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('topics_required')
    await app.close()
  })

  it('topic non couvert par le JWT → 403 topic_not_allowed', async () => {
    const { app } = await buildTestApp()
    const token = await signToken(['orders'])
    const res = await app.inject({
      method: 'GET',
      url: `/subscribe?topics=secret-topic&authorization=${token}`,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ error: string }>().error).toBe('topic_not_allowed')
    await app.close()
  })
})

// ─── Story 4.1 : Headers SSE et stream ──────────────────────────────────────

describe('GET /subscribe — Story 4.1 : SSE stream', () => {
  it('connexion valide → headers text/event-stream corrects', async () => {
    const { app } = await buildTestApp()
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken(['orders'])
    const url = `/subscribe?topics=orders&authorization=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        expect(res.statusCode).toBe(200)
        expect(res.headers['content-type']).toBe('text/event-stream')
        expect(res.headers['cache-control']).toBe('no-cache')
        expect(res.headers['connection']).toBe('keep-alive')
        expect(res.headers['x-accel-buffering']).toBe('no')
        req.destroy()
        resolve()
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') resolve()
        else reject(err)
      })
    })

    await app.close()
  })

  it('connexion valide → événement publié → client reçoit le message SSE', async () => {
    const { app, registry } = await buildTestApp()
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken(['orders'])
    const url = `/subscribe?topics=orders&authorization=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      const req = http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          if (buffer.includes('data:')) {
            expect(buffer).toContain('id: test-evt-1')
            expect(buffer).toContain('data: {"msg":"hello"}')
            req.destroy()
            resolve()
          }
        })
        // Publier après connexion établie
        setTimeout(() => {
          registry.dispatch(`${APP_ID}:orders`, { id: 'test-evt-1', data: { msg: 'hello' } })
        }, 50)
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(err)
      })
      setTimeout(() => reject(new Error('timeout: event not received')), 3000)
    })

    await app.close()
  })

  it('fermeture client → désincription du registry sans erreur', async () => {
    const { app, registry } = await buildTestApp()
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken(['orders'])
    const url = `/subscribe?topics=orders&authorization=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        // Headers reçus = connexion établie et inscrite dans le registry
        expect(res.statusCode).toBe(200)
        setTimeout(() => {
          req.destroy()
          setTimeout(() => {
            expect(() => {
              registry.dispatch(`${APP_ID}:orders`, { id: 'after-close', data: {} })
            }).not.toThrow()
            resolve()
          }, 150)
        }, 50)
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(err)
      })
    })

    await app.close()
  }, 10_000)
})

// ─── Story 4.2 : Multi-topics ───────────────────────────────────────────────

describe('GET /subscribe — Story 4.2 : multi-topics', () => {
  it('deux topics en CSV → subscriber reçoit events des deux', async () => {
    const { app, registry } = await buildTestApp()
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken(['orders:*', 'users:*'])
    const url = `/subscribe?topics=orders:42,users:99&authorization=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      let eventCount = 0

      const req = http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const events = buffer.split('\n\n').filter(e => e.includes('data:'))
          if (events.length >= 2 && eventCount === 0) {
            eventCount = events.length
            expect(buffer).toContain('evt-orders')
            expect(buffer).toContain('evt-users')
            req.destroy()
            resolve()
          }
        })

        setTimeout(() => {
          registry.dispatch(`${APP_ID}:orders:42`, { id: 'evt-orders', data: { t: 'orders' } })
          registry.dispatch(`${APP_ID}:users:99`, { id: 'evt-users', data: { t: 'users' } })
        }, 50)
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(err)
      })
      setTimeout(() => reject(new Error('timeout: events not received')), 3000)
    })

    await app.close()
  })

  it('deux topics en params répétés → comportement identique à CSV', async () => {
    const { app, registry } = await buildTestApp()
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken(['orders:*', 'users:*'])
    const url = `/subscribe?topics=orders:42&topics=users:99&authorization=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      let buffer = ''

      const req = http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const events = buffer.split('\n\n').filter(e => e.includes('data:'))
          if (events.length >= 2) {
            expect(buffer).toContain('rep-orders')
            expect(buffer).toContain('rep-users')
            req.destroy()
            resolve()
          }
        })

        setTimeout(() => {
          registry.dispatch(`${APP_ID}:orders:42`, { id: 'rep-orders', data: {} })
          registry.dispatch(`${APP_ID}:users:99`, { id: 'rep-users', data: {} })
        }, 50)
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(err)
      })
      setTimeout(() => reject(new Error('timeout: events not received')), 3000)
    })

    await app.close()
  })

  it('JWT couvrant topic 1 uniquement + demande topic 2 → 403', async () => {
    const { app } = await buildTestApp()
    const token = await signToken(['orders'])
    const res = await app.inject({
      method: 'GET',
      url: `/subscribe?topics=orders,users&authorization=${token}`,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ error: string }>().error).toBe('topic_not_allowed')
    await app.close()
  })
})

// ─── Story 4.5 : Rate limiting des connexions ────────────────────────────────

describe('GET /subscribe — Story 4.5 : connexions simultanées', () => {
  it('limite dépassée → 429 too_many_connections', async () => {
    await prisma.tenant.update({
      where: { appId: APP_ID },
      data: { rateLimitConnections: 1 },
    })
    const counter = new ConnectionCounter()
    // Pré-charger le compteur à la limite
    counter.increment(APP_ID, undefined, 1)

    const { app } = await buildTestApp(counter)
    const token = await signToken(['orders'])
    const res = await app.inject({
      method: 'GET',
      url: `/subscribe?topics=orders&authorization=${token}`,
    })
    expect(res.statusCode).toBe(429)
    expect(res.json<{ error: string }>().error).toBe('too_many_connections')
    await app.close()
  })

  it('connexion fermée → compteur décrémenté → nouvelle connexion acceptée', async () => {
    await prisma.tenant.update({
      where: { appId: APP_ID },
      data: { rateLimitConnections: 1 },
    })
    const { app, counter } = await buildTestApp()
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken(['orders'])
    const url = `/subscribe?topics=orders&authorization=${encodeURIComponent(token)}`

    // Première connexion — ouverte puis fermée
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        // Headers reçus = connexion établie, compteur incrémenté
        expect(res.statusCode).toBe(200)
        expect(counter.getCount(APP_ID)).toBe(1)
        req.destroy()
        // Attendre que socket 'close' se propage et décrémente le compteur
        setTimeout(resolve, 200)
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(err)
      })
    })

    // Compteur revenu à 0 après fermeture
    expect(counter.getCount(APP_ID)).toBe(0)

    // Deuxième connexion — doit être acceptée (le compteur est à 0)
    await new Promise<void>((resolve, reject) => {
      const token2Promise = signToken(['orders'])
      token2Promise.then(token2 => {
        const url2 = `/subscribe?topics=orders&authorization=${encodeURIComponent(token2)}`
        const req2 = http.get(`http://127.0.0.1:${port}${url2}`, (res2) => {
          expect(res2.statusCode).toBe(200)
          req2.destroy()
          resolve()
        })
        req2.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') resolve()
          else reject(err)
        })
      }).catch(reject)
    })

    await app.close()
  }, 10_000)
})

// ─── Story 5.1 : Replay via lastEventId ─────────────────────────────────────

describe('GET /subscribe — Story 5.1 : replay via lastEventId', () => {
  const TOPIC = 'replay-topic'
  const STREAM_KEY = `hubo:stream:${APP_ID}:${TOPIC}`

  beforeEach(async () => {
    await redis.del(STREAM_KEY)
  })

  afterEach(async () => {
    await redis.del(STREAM_KEY)
  })

  it('reconnexion avec lastEventId=e2 → reçoit e3, e4, e5 dans l\'ordre (AC: 1)', async () => {
    for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) {
      await streamRepo.xadd(STREAM_KEY, id, { seq: id }, 1000, 3600)
    }

    const { app } = await buildTestApp(undefined, streamRepo)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken([TOPIC])
    const url = `/subscribe?topics=${TOPIC}&lastEventId=e2&authorization=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      const req = http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const events = buffer.split('\n\n').filter(e => e.includes('data:'))
          if (events.length >= 3) {
            expect(buffer).toContain('id: e3')
            expect(buffer).toContain('id: e4')
            expect(buffer).toContain('id: e5')
            expect(buffer).not.toContain('id: e1\n')
            expect(buffer).not.toContain('id: e2\n')
            req.destroy()
            resolve()
          }
        })
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(err)
      })
      setTimeout(() => reject(new Error('timeout: replay events not received')), 5000)
    })

    await app.close()
  }, 10_000)

  it('lastEventId inconnu → replay depuis le début sans erreur (AC: 2)', async () => {
    for (const id of ['first-evt', 'second-evt']) {
      await streamRepo.xadd(STREAM_KEY, id, { v: id }, 1000, 3600)
    }

    const { app } = await buildTestApp(undefined, streamRepo)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken([TOPIC])
    const url = `/subscribe?topics=${TOPIC}&lastEventId=unknown-id&authorization=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      const req = http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          if (buffer.includes('first-evt') && buffer.includes('second-evt')) {
            req.destroy()
            resolve()
          }
        })
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(err)
      })
      setTimeout(() => reject(new Error('timeout: events not received')), 5000)
    })

    await app.close()
  }, 10_000)

  it('events rejoués portent leurs IDs originaux (AC: 4)', async () => {
    await streamRepo.xadd(STREAM_KEY, 'original-id-abc', { data: 'test' }, 1000, 3600)

    const { app } = await buildTestApp(undefined, streamRepo)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken([TOPIC])
    const url = `/subscribe?topics=${TOPIC}&lastEventId=unknown&authorization=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      const req = http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          if (buffer.includes('original-id-abc')) {
            expect(buffer).toContain('id: original-id-abc')
            req.destroy()
            resolve()
          }
        })
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(err)
      })
      setTimeout(() => reject(new Error('timeout: event not received')), 5000)
    })

    await app.close()
  }, 10_000)
})

// ─── Story 5.2 : Header Last-Event-ID standard SSE ──────────────────────────

describe('GET /subscribe — Story 5.2 : header Last-Event-ID', () => {
  const TOPIC = 'header-topic'
  const STREAM_KEY = `hubo:stream:${APP_ID}:${TOPIC}`

  beforeEach(async () => {
    await redis.del(STREAM_KEY)
  })

  afterEach(async () => {
    await redis.del(STREAM_KEY)
  })

  it('header Last-Event-ID → replay depuis ce point (AC: 1)', async () => {
    for (const id of ['h1', 'h2', 'h3']) {
      await streamRepo.xadd(STREAM_KEY, id, { seq: id }, 1000, 3600)
    }

    const { app } = await buildTestApp(undefined, streamRepo)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken([TOPIC])
    const url = `/subscribe?topics=${TOPIC}&authorization=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      const req = http.get(
        `http://127.0.0.1:${port}${url}`,
        { headers: { 'Last-Event-ID': 'h1' } },
        (res) => {
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            if (buffer.includes('id: h2') && buffer.includes('id: h3')) {
              expect(buffer).not.toContain('id: h1\n')
              req.destroy()
              resolve()
            }
          })
        }
      )
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(err)
      })
      setTimeout(() => reject(new Error('timeout: events not received')), 5000)
    })

    await app.close()
  }, 10_000)

  it('header ET query param présents → header utilisé (AC: 2)', async () => {
    for (const id of ['p1', 'p2', 'p3']) {
      await streamRepo.xadd(STREAM_KEY, id, { seq: id }, 1000, 3600)
    }

    const { app } = await buildTestApp(undefined, streamRepo)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken([TOPIC])
    // query param dit p2, header dit p1 → header a priorité → reçoit p2, p3
    const url = `/subscribe?topics=${TOPIC}&lastEventId=p2&authorization=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      const req = http.get(
        `http://127.0.0.1:${port}${url}`,
        { headers: { 'Last-Event-ID': 'p1' } },
        (res) => {
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            if (buffer.includes('id: p2') && buffer.includes('id: p3')) {
              expect(buffer).not.toContain('id: p1\n')
              req.destroy()
              resolve()
            }
          })
        }
      )
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(err)
      })
      setTimeout(() => reject(new Error('timeout: events not received')), 5000)
    })

    await app.close()
  }, 10_000)

  it('query param seul (sans header) → utilisé pour replay', async () => {
    for (const id of ['q1', 'q2', 'q3']) {
      await streamRepo.xadd(STREAM_KEY, id, { seq: id }, 1000, 3600)
    }

    const { app } = await buildTestApp(undefined, streamRepo)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const token = await signToken([TOPIC])
    const url = `/subscribe?topics=${TOPIC}&lastEventId=q1&authorization=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      const req = http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          if (buffer.includes('id: q2') && buffer.includes('id: q3')) {
            expect(buffer).not.toContain('id: q1\n')
            req.destroy()
            resolve()
          }
        })
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(err)
      })
      setTimeout(() => reject(new Error('timeout: events not received')), 5000)
    })

    await app.close()
  }, 10_000)
})
