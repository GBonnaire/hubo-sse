import fp from 'fastify-plugin'
import type { TenantsManager } from '../tenants/TenantsManager.js'
import { verifySubscriberJwt, AuthError } from '../auth/verifyJwt.js'

export default fp<{ manager: TenantsManager }>(async (app, opts) => {
  const { manager } = opts

  app.decorate('verifySubscriber', async function (
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) {
    try {
      const query = request.query as { authorization?: string }
      const headers = { authorization: request.headers.authorization }
      request.jwtPayload = await verifySubscriberJwt(headers, query, manager)
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.status).send({ error: err.code })
      }
      return reply.code(500).send({ error: 'Internal Server Error' })
    }
  })
})
