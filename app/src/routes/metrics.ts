import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import type { MetricsRegistry } from '../metrics/MetricsRegistry.js'

export async function metricsRoutes(
  fastify: FastifyInstance,
  opts: { config: AppConfig; metrics: MetricsRegistry },
): Promise<void> {
  fastify.get('/metrics', async (request, reply) => {
    const { adminToken } = opts.config
    if (adminToken) {
      const auth = request.headers.authorization
      if (auth !== `Bearer ${adminToken}`) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
    }
    reply.header('Content-Type', 'text/plain; version=0.0.4')
    return opts.metrics.serialize()
  })
}
