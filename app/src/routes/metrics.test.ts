import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../app.js'
import type { AppConfig } from '../config.js'
import { metricsRegistry } from '../metrics/MetricsRegistry.js'

const baseConfig: AppConfig = {
  port: 3000,
  redis: 'redis://redis:6379',
  database: 'mysql://admin:admin@db:3306/hubo',
  logLevel: 'error',
  httpsRedirect: false,
}

beforeEach(() => {
  metricsRegistry.reset()
})

describe('GET /metrics — auth (AC: 1, 2)', () => {
  it('AC1 : sans adminToken dans config → accessible sans auth (200)', async () => {
    const app = await buildApp(baseConfig)
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('AC1 : avec adminToken configuré + pas de token → 401', async () => {
    const app = await buildApp({ ...baseConfig, adminToken: 'secret-admin' })
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('AC1 : mauvais token → 401', async () => {
    const app = await buildApp({ ...baseConfig, adminToken: 'secret-admin' })
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer wrong-token' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('AC2 : bon token → 200 avec Content-Type Prometheus', async () => {
    const app = await buildApp({ ...baseConfig, adminToken: 'secret-admin' })
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer secret-admin' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.headers['content-type']).toContain('version=0.0.4')
    await app.close()
  })
})

describe('MetricsRegistry — compteurs (AC: 3)', () => {
  it('AC3 : events_published_total incrémenté après publish', () => {
    metricsRegistry.increment('hubo_events_published_total', { tenant: 'app1' })
    metricsRegistry.increment('hubo_events_published_total', { tenant: 'app1' })

    const output = metricsRegistry.serialize()
    expect(output).toContain('hubo_events_published_total{tenant="app1"} 2')
  })

  it('AC3 : connections_active mis à jour via gauge', () => {
    metricsRegistry.gauge('hubo_connections_active', 5, { tenant: 'app1' })

    const output = metricsRegistry.serialize()
    expect(output).toContain('hubo_connections_active{tenant="app1"} 5')
  })

  it('serialize inclut les latences p50/p95/p99 quand données disponibles', () => {
    for (let i = 1; i <= 100; i++) {
      metricsRegistry.recordLatency(i)
    }

    const output = metricsRegistry.serialize()
    expect(output).toContain('hubo_publish_latency_ms{quantile="0.5"}')
    expect(output).toContain('hubo_publish_latency_ms{quantile="0.95"}')
    expect(output).toContain('hubo_publish_latency_ms{quantile="0.99"}')
  })
})
