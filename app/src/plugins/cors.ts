import fp from 'fastify-plugin'
import type { TenantsManager } from '../tenants/TenantsManager.js'

export default fp<{ manager: TenantsManager }>(async (app, opts) => {
  const { manager } = opts

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (!origin) return

    const allTenants = manager.getAllTenants()
    const allowed = allTenants.some(t => (t.origins as string[]).includes(origin))

    if (!allowed) {
      return reply.code(403).send({ error: 'Origin not allowed' })
    }

    reply.header('Access-Control-Allow-Origin', origin)
    reply.header('Access-Control-Allow-Credentials', 'true')
    reply.header('Vary', 'Origin')
    // Nécessaire pour les réponses SSE qui utilisent reply.hijack() + writeHead() :
    // writeHead() ne tient pas compte des headers bufferisés par Fastify (reply.header),
    // donc on les écrit aussi sur reply.raw directement.
    reply.raw.setHeader('Access-Control-Allow-Origin', origin)
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true')
    reply.raw.setHeader('Vary', 'Origin')

    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      return reply.code(204).send()
    }
  })
})
