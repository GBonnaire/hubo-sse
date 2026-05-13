import type { FastifyInstance } from 'fastify'
import { getRedis } from '../redis/redis.js'
import { prisma } from '../db/prisma.js'
import type { AppConfig } from '../config.js'
import type { ConnectionCounter } from '../subscriber/ConnectionCounter.js'

export interface HealthResponse {
  status: 'ok' | 'degraded'
  redis: 'ok' | 'error'
  database: 'ok' | 'error'
  uptime: number
  connections: number
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])

export async function healthHandler(config: AppConfig, counter?: ConnectionCounter): Promise<HealthResponse> {
  const redis = getRedis(config.redis)
  const uptime = Math.floor(process.uptime())
  const connections = counter?.totalCount() ?? 0

  const [redisStatus, dbStatus] = await Promise.all([
    withTimeout(redis.ping(), 1000).then(() => 'ok' as const).catch(() => 'error' as const),
    withTimeout(prisma.$queryRaw`SELECT 1`, 1000).then(() => 'ok' as const).catch(() => 'error' as const),
  ])

  const status = redisStatus === 'ok' && dbStatus === 'ok' ? 'ok' : 'degraded'
  return { status, redis: redisStatus, database: dbStatus, uptime, connections }
}

export async function healthRoutes(
  fastify: FastifyInstance,
  opts: { config: AppConfig; counter?: ConnectionCounter },
): Promise<void> {
  fastify.get('/health', async (_, reply) => {
    const health = await healthHandler(opts.config, opts.counter)
    const code = health.status === 'ok' ? 200 : 503
    return reply.code(code).send(health)
  })
}
