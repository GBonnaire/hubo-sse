import type { FastifyInstance } from 'fastify'
import { verifyPublisherJwt, AuthError } from '../auth/verifyJwt.js'
import type { TenantsManager } from '../tenants/TenantsManager.js'
import type { SubscriberRegistry } from '../subscriber/SubscriberRegistry.js'

export async function listenersRoutes(
  fastify: FastifyInstance,
  opts: { manager: TenantsManager; registry: SubscriberRegistry },
): Promise<void> {
  const { manager, registry } = opts

  fastify.get<{ Params: { topic: string } }>(
    '/listeners/:topic',
    async (request, reply) => {
      try {
        const jwt = await verifyPublisherJwt(request.headers.authorization, manager)
        const topicKey = `${jwt.iss}:${request.params.topic}`
        const count = registry.countByTopic(topicKey)
        return reply.send({ topic: request.params.topic, listeners: count })
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(err.status).send({ error: err.code })
        }
        return reply.code(500).send({ error: 'Internal Server Error' })
      }
    },
  )
}
