import { z } from 'zod'
import { parse as dotenvParse } from 'dotenv'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

function readPackageVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(resolve(dir, '../package.json'), 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION = readPackageVersion()

const ConfigSchema = z.object({
  port: z.number().int().positive().default(3000),
  redis: z.url(),
  database: z.string().min(1),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  httpsRedirect: z.boolean().default(false),
  adminToken: z.string().optional(),
})

export type AppConfig = z.infer<typeof ConfigSchema>

function parseEnvFile(filePath: string): Record<string, string> {
  const abs = resolve(process.cwd(), filePath)
  if (!existsSync(abs)) return {}
  return dotenvParse(readFileSync(abs, 'utf-8'))
}

export function loadConfig(opts?: { envFile?: string; localEnvFile?: string }): AppConfig {
  const base = parseEnvFile(opts?.envFile ?? '.env')
  const local = parseEnvFile(opts?.localEnvFile ?? '.env.local')

  // Priority: process.env > .env.local > .env
  const env: Record<string, string | undefined> = { ...base, ...local, ...process.env }

  const values: Record<string, unknown> = {}
  const rawPort = env.PORT ?? "3000"
  if (rawPort) {
    const port = parseInt(rawPort, 10)
    if (isNaN(port)) throw new Error(`Port invalide : "${rawPort}" n'est pas un entier`)
    values.port = port
  }
  if (env.REDIS_URL) values.redis = env.REDIS_URL
  if (env.DATABASE_URL) values.database = env.DATABASE_URL
  if (env.HUBO_LOG_LEVEL) values.logLevel = env.HUBO_LOG_LEVEL
  if (env.HUBO_HTTPS_REDIRECT) values.httpsRedirect = env.HUBO_HTTPS_REDIRECT === 'true'
  if (env.HUBO_ADMIN_TOKEN) values.adminToken = env.HUBO_ADMIN_TOKEN

  const result = ConfigSchema.safeParse(values)
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`Configuration invalide — champs manquants ou incorrects : ${fields}`)
  }

  return result.data
}
