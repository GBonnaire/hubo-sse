import { describe, it, expect } from 'vitest'
import { buildApp } from './app.js'
import type { AppConfig } from './config.js'

const testConfig: AppConfig = {
  port: 3000,
  redis: 'redis://redis:6379',
  database: 'mysql://admin:admin@db:3306/hubo',
  logLevel: 'error',
  httpsRedirect: false,
}

describe('buildApp', () => {
  it('retourne 404 sur une route inconnue', async () => {
    const app = await buildApp(testConfig)
    const res = await app.inject({ method: 'GET', url: '/nonexistent' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Not Found' })
    await app.close()
  })

  it('retourne 500 sans stack trace en mode production', async () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const app = await buildApp(testConfig)
    app.get('/boom', () => {
      throw new Error('internal failure')
    })
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)
    const body = res.json<{ error: string }>()
    expect(body).not.toHaveProperty('stack')
    expect(body.error).toBe('internal failure')
    process.env.NODE_ENV = original
    await app.close()
  })

  it('redirige vers HTTPS si httpsRedirect=true et proto http', async () => {
    const app = await buildApp({ ...testConfig, httpsRedirect: true })
    const res = await app.inject({
      method: 'GET',
      url: '/any',
      headers: { 'x-forwarded-proto': 'http' },
    })
    expect(res.statusCode).toBe(301)
    await app.close()
  })
})
