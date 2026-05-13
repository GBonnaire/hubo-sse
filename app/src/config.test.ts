import { describe, it, expect, afterEach } from 'vitest'
import { loadConfig } from './config.js'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => {
  delete process.env.HUBO_PORT
  delete process.env.REDIS_URL
  delete process.env.DATABASE_URL
  delete process.env.HUBO_LOG_LEVEL
  delete process.env.HUBO_HTTPS_REDIRECT
  delete process.env.HUBO_ADMIN_TOKEN
})

let _seq = 0
function writeTmpEnv(content: string): string {
  const path = join(tmpdir(), `hubo-test-${Date.now()}-${++_seq}.env`)
  writeFileSync(path, content)
  return path
}

const validEnv = `
HUBO_PORT=4000
REDIS_URL=redis://redis:6379
DATABASE_URL=mysql://admin:admin@db:3306/hubo
HUBO_LOG_LEVEL=debug
HUBO_HTTPS_REDIRECT=false
`

describe('loadConfig', () => {
  it('charge correctement un fichier .env valide', () => {
    const path = writeTmpEnv(validEnv)
    const config = loadConfig({ envFile: path })
    unlinkSync(path)
    expect(config.port).toBe(4000)
    expect(config.redis).toBe('redis://redis:6379')
    expect(config.logLevel).toBe('debug')
  })

  it('applique les défauts pour les champs optionnels', () => {
    const path = writeTmpEnv('REDIS_URL=redis://redis:6379\nDATABASE_URL=mysql://x:x@db:3306/hubo')
    const config = loadConfig({ envFile: path })
    unlinkSync(path)
    expect(config.port).toBe(3000)
    expect(config.logLevel).toBe('info')
    expect(config.httpsRedirect).toBe(false)
  })

  it('process.env surcharge .env', () => {
    const path = writeTmpEnv(validEnv)
    process.env.HUBO_PORT = '9000'
    const config = loadConfig({ envFile: path })
    unlinkSync(path)
    expect(config.port).toBe(9000)
  })

  it('.env.local surcharge .env', () => {
    const envFile = writeTmpEnv(validEnv)
    const localFile = writeTmpEnv('HUBO_PORT=7777')
    const config = loadConfig({ envFile, localEnvFile: localFile })
    unlinkSync(envFile)
    unlinkSync(localFile)
    expect(config.port).toBe(7777)
  })

  it('process.env surcharge .env.local', () => {
    const envFile = writeTmpEnv(validEnv)
    const localFile = writeTmpEnv('HUBO_PORT=7777')
    process.env.HUBO_PORT = '9999'
    const config = loadConfig({ envFile, localEnvFile: localFile })
    unlinkSync(envFile)
    unlinkSync(localFile)
    expect(config.port).toBe(9999)
  })

  it("les variables d'env seules (sans fichier) fonctionnent", () => {
    process.env.REDIS_URL = 'redis://redis:6379'
    process.env.DATABASE_URL = 'mysql://admin:admin@db:3306/hubo'
    const config = loadConfig({ envFile: '/nonexistent/.env' })
    expect(config.redis).toBe('redis://redis:6379')
    expect(config.database).toBe('mysql://admin:admin@db:3306/hubo')
  })

  it('champ requis manquant → erreur avec le nom du champ', () => {
    const path = writeTmpEnv('HUBO_PORT=3000')
    try {
      expect(() => loadConfig({ envFile: path })).toThrow(/redis|database/i)
    } finally {
      unlinkSync(path)
    }
  })
})
