import type { FastifyInstance } from 'fastify'
import type { ConnectionRegistry } from '../subscriber/ConnectionRegistry.js'

export async function unsubscribeRoutes(
  fastify: FastifyInstance,
  opts: { connectionRegistry: ConnectionRegistry },
): Promise<void> {
  const { connectionRegistry } = opts

  fastify.post('/unsubscribe', async (request, reply) => {
    const body = request.body as { connectionId?: string }
    const connectionId = body?.connectionId

    if (!connectionId || typeof connectionId !== 'string') {
      return reply.code(400).send({ error: 'connection_id_required' })
    }

    const found = connectionRegistry.invoke(connectionId)
    return reply.code(found ? 200 : 404).send(found ? { ok: true } : { error: 'not_found' })
  })
}
