import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { verifySubscriberJwt, AuthError } from '../auth/verifyJwt.js'
import { areTopicsAllowed } from '../auth/topicMatcher.js'
import type { TenantsManager } from '../tenants/TenantsManager.js'
import type { SubscriberRegistry, SSEEvent } from '../subscriber/SubscriberRegistry.js'
import type { ConnectionCounter } from '../subscriber/ConnectionCounter.js'
import type { StreamRepository } from '../redis/StreamRepository.js'
import { SSEConnection } from '../subscriber/SSEConnection.js'
import type { MetricsRegistry } from '../metrics/MetricsRegistry.js'

export function parseTopics(raw: string | string[] | undefined): string[] {
  if (!raw) return []
  const arr = Array.isArray(raw) ? raw : [raw]
  return [...new Set(arr.flatMap(t => t.split(',').map(s => s.trim()).filter(Boolean)))]
}

export function resolveLastEventId(
  headers: { 'last-event-id'?: string },
  query: { lastEventId?: string },
): string | undefined {
  return headers['last-event-id'] ?? query.lastEventId
}

export async function subscribeRoutes(
  fastify: FastifyInstance,
  opts: {
    manager: TenantsManager
    registry: SubscriberRegistry
    counter: ConnectionCounter
    streamRepo?: StreamRepository
    redis?: import('ioredis').Redis
    metrics: MetricsRegistry
  },
): Promise<void> {
  const { manager, registry, counter, streamRepo, redis, metrics } = opts

  async function verifySubscriberHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const query = request.query as { authorization?: string }
      request.jwtPayload = await verifySubscriberJwt(
        { authorization: request.headers.authorization },
        query,
        manager,
        redis,
      )
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

  fastify.get<{
    Headers: { 'last-event-id'?: string }
    Querystring: { topics?: string | string[]; authorization?: string; lastEventId?: string }
  }>('/subscribe', {
    preHandler: [verifySubscriberHook],
  }, async (request, reply) => {
    const jwtPayload = request.jwtPayload!
    const parsedTopics = parseTopics(request.query.topics)

    if (parsedTopics.length === 0) {
      return reply.code(400).send({ error: 'topics_required' })
    }

    if (!areTopicsAllowed(parsedTopics, jwtPayload.topics)) {
      return reply.code(403).send({ error: 'topic_not_allowed' })
    }

    const tenant = manager.getTenant(jwtPayload.iss)!
    const sessionId = jwtPayload.session_id

    const allowed = counter.increment(jwtPayload.iss, sessionId, tenant.rateLimitConnections)
    if (!allowed) {
      return reply.code(429).send({ error: 'too_many_connections' })
    }

    const lastEventId = resolveLastEventId(request.headers, request.query)
    const topicKeys = parsedTopics.map(t => `${jwtPayload.iss}:${t}`)

    /*
     * Stratégie zéro-perte pour l'établissement de la connexion SSE :
     *
     * 1. On abonne immédiatement une connexion "buffer" qui accumule les events
     *    temps réel arrivant pendant l'opération de replay (potentiellement lente).
     * 2. On rejoue les events manqués depuis Redis Stream (si `lastEventId` fourni).
     * 3. On souscrit la vraie connexion SSE AVANT de désabonner le buffer,
     *    garantissant qu'aucun event ne tombe dans le vide pendant la transition.
     * 4. On vide le buffer en dédupliquant par rapport aux events déjà rejoués.
     */
    const bufferedEvents: SSEEvent[] = []
    const bufferConn = {
      id: `buffer-${crypto.randomUUID()}`,
      tenantId: jwtPayload.iss,
      send: (e: SSEEvent) => { bufferedEvents.push(e) },
    }

    for (const key of topicKeys) {
      registry.subscribe(key, bufferConn)
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.flushHeaders()

    const connection = new SSEConnection(reply.raw, jwtPayload.iss, jwtPayload.exp)

    request.log.debug({ tenant_id: jwtPayload.iss, connection_id: connection.id, topics: parsedTopics }, 'SSE connection opened')

    // Étape 2 : replay depuis Redis Stream
    const replayedIds = new Set<string>()
    if (lastEventId && streamRepo) {
      for (const topic of parsedTopics) {
        const streamKey = `hubo:stream:${jwtPayload.iss}:${topic}`
        const replayEvents = await streamRepo.xrange(streamKey, lastEventId)
        for (const event of replayEvents) {
          connection.send(event)
          replayedIds.add(event.id)
        }
      }
    }

    // Étape 3 : abonner la vraie connexion AVANT de retirer le buffer (pas de gap)
    for (const key of topicKeys) {
      registry.subscribe(key, connection)
      registry.unsubscribe(key, bufferConn)
    }

    // Étape 4 : vider le buffer en dédupliquant
    for (const event of bufferedEvents) {
      if (!replayedIds.has(event.id)) {
        connection.send(event)
      }
    }

    request.socket.on('end', () => {
      request.log.debug({ connection_id: connection.id }, 'SSE connection closed')
      connection.close()
      counter.decrement(jwtPayload.iss, sessionId)
      for (const key of topicKeys) {
        registry.unsubscribe(key, connection)
      }
    })
  })
}
