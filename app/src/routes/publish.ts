import { z } from 'zod'
import { decodeJwt } from 'jose'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { verifyPublisherJwt, AuthError } from '../auth/verifyJwt.js'
import { areTopicsAllowed } from '../auth/topicMatcher.js'
import type { TenantsManager } from '../tenants/TenantsManager.js'
import type { PublisherService } from '../publisher/PublisherService.js'
import type { MetricsRegistry } from '../metrics/MetricsRegistry.js'

export const PublishBodySchema = z.object({
  topics: z.array(z.string().min(1)).min(1, {
    message: 'topics must have at least one element',
  }),
  data: z.record(z.string(), z.unknown()).refine(
    (val) => {
      try {
        JSON.stringify(val)
        return true
      } catch {
        return false
      }
    },
    { message: 'data must be JSON-serializable' },
  ),
  private: z.boolean().default(false),
  id: z.string().optional(),
  retry: z.number().int().positive().optional(),
})

export type PublishBody = z.infer<typeof PublishBodySchema>

export async function publishRoutes(
  fastify: FastifyInstance,
  opts: { manager: TenantsManager; publisherService: PublisherService; redis?: import('ioredis').Redis; metrics: MetricsRegistry },
): Promise<void> {
  const { manager, publisherService, redis, metrics } = opts

  async function verifyPublisherHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      request.jwtPayload = await verifyPublisherJwt(request.headers.authorization, manager, redis)
    } catch (err) {
      if (err instanceof AuthError) {
        request.log.warn({ reason: err.code, tenant_id: err.tenantId ?? 'unknown' }, 'JWT validation failed')
        metrics.increment('hubo_jwt_errors_total', { tenant: err.tenantId ?? 'unknown', reason: err.code })
        await reply.code(err.status).send({ error: err.code })
        return
      }
      await reply.code(500).send({ error: 'Internal Server Error' })
    }
  }

  async function checkPayloadSizeHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const jwtPayload = request.jwtPayload
    if (!jwtPayload) return
    const tenant = manager.getTenant(jwtPayload.iss)
    if (!tenant) return
    const bodySize = Buffer.byteLength(JSON.stringify(request.body), 'utf8')
    if (bodySize > tenant.maxEventSize) {
      await reply.code(413).send({ error: 'payload_too_large' })
    }
  }

  fastify.post(
    '/publish',
    {
      config: {
        rateLimit: {
          max: async (_request: FastifyRequest, key: string | number) => {
            const tenant = manager.getTenant(typeof key === 'string' ? key : String(key))
            return tenant?.rateLimitPublish ?? 100
          },
          timeWindow: '1 second',
          keyGenerator: (request: FastifyRequest): string => {
            const authHeader = request.headers.authorization
            if (authHeader?.startsWith('Bearer ')) {
              try {
                const decoded = decodeJwt(authHeader.slice(7))
                if (typeof decoded.iss === 'string') return decoded.iss
              } catch {
                // fall through to IP fallback
              }
            }
            return request.ip
          },
          errorResponseBuilder: (_req, context) => {
            const err = Object.assign(new Error('rate_limit_exceeded'), {
              statusCode: context.statusCode,
            })
            return err
          },
        },
      },
      preHandler: [verifyPublisherHook, checkPayloadSizeHook],
    },
    async (request, reply) => {
      const parseResult = PublishBodySchema.safeParse(request.body)
      if (!parseResult.success) {
        const firstIssue = parseResult.error.issues[0]
        return reply.code(400).send({ error: firstIssue?.message ?? 'Validation error' })
      }

      const body = parseResult.data
      const jwtPayload = request.jwtPayload!

      if (!areTopicsAllowed(body.topics, jwtPayload.topics)) {
        return reply.code(403).send({ error: 'topic_not_allowed' })
      }

      const publishOpts: import('../publisher/PublisherService.js').PublishOptions = {
        private: body.private,
      }
      if (body.id !== undefined) publishOpts.id = body.id
      if (body.retry !== undefined) publishOpts.retry = body.retry

      const id = await publisherService.publish(jwtPayload.iss, body.topics, body.data, publishOpts)

      return reply.send({ id })
    },
  )
}
