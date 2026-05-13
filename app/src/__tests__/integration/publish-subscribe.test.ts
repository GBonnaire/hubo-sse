import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  prisma,
  TEST_TENANT_A,
  TEST_TENANT_B,
  setupTenants,
  teardownTenants,
  buildTestApp,
  makeToken,
  readSSE,
  waitFor,
} from './setup.js'

beforeAll(async () => {
  await setupTenants()
})

afterAll(async () => {
  await teardownTenants()
})

// ── Scénario 1 : publish + subscribe immédiat ──────────────────────────────
it('S1 : délivre un event en < 500ms', async () => {
  const { app, port } = await buildTestApp()
  try {
    const subToken = await makeToken(TEST_TENANT_A.appId, TEST_TENANT_A.secret, 'subscribe', ['integ:s1'])
    const pubToken = await makeToken(TEST_TENANT_A.appId, TEST_TENANT_A.secret, 'publish', ['integ:s1'])

    const ctrl = new AbortController()
    const received: Record<string, unknown>[] = []
    const start = Date.now()

    const sseRes = await fetch(
      `http://localhost:${port}/subscribe?topics=integ:s1&authorization=${subToken}`,
      { signal: ctrl.signal },
    )
    expect(sseRes.status).toBe(200)

    const collectPromise = (async () => {
      for await (const msg of readSSE(sseRes, ctrl.signal)) {
        if (msg.event) continue
        received.push(JSON.parse(msg.data))
        ctrl.abort()
      }
    })()

    await new Promise((r) => setTimeout(r, 50))

    await fetch(`http://localhost:${port}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pubToken}` },
      body: JSON.stringify({ topics: ['integ:s1'], data: { value: 42 } }),
    })

    await collectPromise.catch(() => {})
    await waitFor(() => received.length > 0, 1000)

    expect(Date.now() - start).toBeLessThan(500)
    expect(received[0]).toMatchObject({ value: 42 })
  } finally {
    await app.close()
  }
})

// ── Scénario 2 : replay après reconnexion (Last-Event-ID) ─────────────────
it('S2 : replay depuis Last-Event-ID lors de la reconnexion', async () => {
  const { app, port } = await buildTestApp()
  try {
    const pubToken = await makeToken(TEST_TENANT_A.appId, TEST_TENANT_A.secret, 'publish', ['integ:s2'])
    const subToken = await makeToken(TEST_TENANT_A.appId, TEST_TENANT_A.secret, 'subscribe', ['integ:s2'])

    const publishRes = await fetch(`http://localhost:${port}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pubToken}` },
      body: JSON.stringify({ topics: ['integ:s2'], data: { seq: 1 } }),
    })
    const { id: eventId } = (await publishRes.json()) as { id: string }

    await fetch(`http://localhost:${port}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pubToken}` },
      body: JSON.stringify({ topics: ['integ:s2'], data: { seq: 2 } }),
    })

    const ctrl = new AbortController()
    const replayed: Record<string, unknown>[] = []
    const replayRes = await fetch(
      `http://localhost:${port}/subscribe?topics=integ:s2&authorization=${subToken}`,
      {
        signal: ctrl.signal,
        headers: { 'Last-Event-ID': eventId },
      },
    )

    const collectPromise = (async () => {
      for await (const msg of readSSE(replayRes, ctrl.signal)) {
        if (msg.event) continue
        replayed.push(JSON.parse(msg.data))
        if (replayed.length >= 1) ctrl.abort()
      }
    })()

    await collectPromise.catch(() => {})
    await waitFor(() => replayed.length >= 1, 1000)

    expect(replayed[0]).toMatchObject({ seq: 2 })
  } finally {
    await app.close()
  }
})

// ── Scénario 3 : multi-topics ─────────────────────────────────────────────
it('S3 : subscriber multi-topics reçoit les events des deux topics', async () => {
  const { app, port } = await buildTestApp()
  try {
    const pubToken = await makeToken(TEST_TENANT_A.appId, TEST_TENANT_A.secret, 'publish', ['integ:s3a', 'integ:s3b'])
    const subToken = await makeToken(TEST_TENANT_A.appId, TEST_TENANT_A.secret, 'subscribe', ['integ:s3a', 'integ:s3b'])

    const ctrl = new AbortController()
    const received: Record<string, unknown>[] = []

    const sseRes = await fetch(
      `http://localhost:${port}/subscribe?topics=integ:s3a,integ:s3b&authorization=${subToken}`,
      { signal: ctrl.signal },
    )

    const collectPromise = (async () => {
      for await (const msg of readSSE(sseRes, ctrl.signal)) {
        if (msg.event) continue
        received.push(JSON.parse(msg.data))
        if (received.length >= 2) ctrl.abort()
      }
    })()

    await new Promise((r) => setTimeout(r, 50))

    await fetch(`http://localhost:${port}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pubToken}` },
      body: JSON.stringify({ topics: ['integ:s3a'], data: { topic: 'a' } }),
    })
    await fetch(`http://localhost:${port}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pubToken}` },
      body: JSON.stringify({ topics: ['integ:s3b'], data: { topic: 'b' } }),
    })

    await collectPromise.catch(() => {})
    await waitFor(() => received.length >= 2, 2000)

    const topics = received.map((r) => (r as { topic: string }).topic)
    expect(topics).toContain('a')
    expect(topics).toContain('b')
  } finally {
    await app.close()
  }
})

// ── Scénario 4 : token.expired ────────────────────────────────────────────
it('S4 : token.expired envoyé quand le JWT expire', async () => {
  const { app, port } = await buildTestApp()
  try {
    // Token expiring in 1 second
    const subToken = await makeToken(
      TEST_TENANT_A.appId, TEST_TENANT_A.secret, 'subscribe', ['integ:s4'],
      Math.floor(Date.now() / 1000) + 1,
    )

    const ctrl = new AbortController()
    const events: string[] = []

    const sseRes = await fetch(
      `http://localhost:${port}/subscribe?topics=integ:s4&authorization=${subToken}`,
      { signal: ctrl.signal },
    )

    const collectPromise = (async () => {
      for await (const msg of readSSE(sseRes, ctrl.signal)) {
        if (msg.event) {
          events.push(msg.event)
          ctrl.abort()
        }
      }
    })()

    await collectPromise.catch(() => {})
    await waitFor(() => events.length > 0, 3000)

    expect(events).toContain('token.expired')
  } finally {
    await app.close()
  }
})

// ── Scénario 5 : JWT expiré à la connexion → 401 ─────────────────────────
it('S5 : JWT déjà expiré à la connexion → 401', async () => {
  const { app, port } = await buildTestApp()
  try {
    const expiredToken = await makeToken(
      TEST_TENANT_A.appId, TEST_TENANT_A.secret, 'subscribe', ['integ:s5'], '-1s',
    )
    const res = await fetch(
      `http://localhost:${port}/subscribe?topics=integ:s5&authorization=${expiredToken}`,
    )
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('token_expired')
  } finally {
    await app.close()
  }
})

// ── Scénario 6 : rate limit publish (101ème → 429) ────────────────────────
it('S6 : rate limit publish : 6ème requête/sec → 429 (tenant avec limit=5)', async () => {
  const { app, port } = await buildTestApp()
  try {
    const pubToken = await makeToken(TEST_TENANT_A.appId, TEST_TENANT_A.secret, 'publish', ['integ:s6'])

    // tenant A has rateLimitPublish=5 (set in TEST_TENANT_A)
    let rateLimitHit = false
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`http://localhost:${port}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pubToken}` },
        body: JSON.stringify({ topics: ['integ:s6'], data: { i } }),
      })
      if (res.status === 429) {
        rateLimitHit = true
        break
      }
    }
    expect(rateLimitHit).toBe(true)
  } finally {
    await app.close()
  }
})

// ── Scénario 7 : isolation tenant ─────────────────────────────────────────
it('S7 : isolation tenant — event tenant A invisible pour subscriber tenant B', async () => {
  const { app, port } = await buildTestApp()
  try {
    const pubTokenA = await makeToken(TEST_TENANT_A.appId, TEST_TENANT_A.secret, 'publish', ['integ:s7'])
    const subTokenB = await makeToken(TEST_TENANT_B.appId, TEST_TENANT_B.secret, 'subscribe', ['integ:s7'])

    const ctrl = new AbortController()
    const receivedByB: unknown[] = []

    const sseRes = await fetch(
      `http://localhost:${port}/subscribe?topics=integ:s7&authorization=${subTokenB}`,
      { signal: ctrl.signal },
    )

    const collectPromise = (async () => {
      for await (const msg of readSSE(sseRes, ctrl.signal)) {
        if (!msg.event) receivedByB.push(JSON.parse(msg.data))
      }
    })()

    await new Promise((r) => setTimeout(r, 50))

    await fetch(`http://localhost:${port}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pubTokenA}` },
      body: JSON.stringify({ topics: ['integ:s7'], data: { secret: 'tenant-a-data' } }),
    })

    await new Promise((r) => setTimeout(r, 200))
    ctrl.abort()

    await collectPromise.catch(() => {})

    // B should not have received any events from A
    expect(receivedByB).toHaveLength(0)
  } finally {
    await app.close()
  }
})

// ── Scénario bonus: subscribe sans topics → 400 ───────────────────────────
describe('validation SSE', () => {
  it('subscribe sans topics → 400', async () => {
    const { app, port } = await buildTestApp()
    try {
      const subToken = await makeToken(TEST_TENANT_A.appId, TEST_TENANT_A.secret, 'subscribe', ['*'])
      const res = await fetch(
        `http://localhost:${port}/subscribe?authorization=${subToken}`,
      )
      expect(res.status).toBe(400)
    } finally {
      await app.close()
    }
  })
})
