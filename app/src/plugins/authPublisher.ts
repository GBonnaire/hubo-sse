import fp from 'fastify-plugin'
import type { TenantsManager } from '../tenants/TenantsManager.js'
import { verifyPublisherJwt, AuthError } from '../auth/verifyJwt.js'

declare module 'fastify' {
  interface FastifyRequest {
    jwtPayload?: import('../auth/verifyJwt.js').HuboJwtPayload
  }
}

export default fp<{ manager: TenantsManager }>(async (app, opts) => {
  const { manager } = opts

  app.decorate('verifyPublisher', async function (
    this: import('fastify').FastifyInstance,
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) {
    try {
      request.jwtPayload = await verifyPublisherJwt(request.headers.authorization, manager)
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.status).send({ error: err.code })
      }
      return reply.code(500).send({ error: 'Internal Server Error' })
    }
  })
})
