import { uuidv7 } from 'uuidv7'
import type { Logger } from 'pino'
import type { Redis } from 'ioredis'
import type { SubscriberRegistry, SSEEvent } from '../subscriber/SubscriberRegistry.js'
import type { StreamRepository } from '../redis/StreamRepository.js'
import type { TenantsManager } from '../tenants/TenantsManager.js'
import { MetricsRegistry } from '../metrics/MetricsRegistry.js'

export interface PublishOptions {
  id?: string
  retry?: number
  private?: boolean
}

export class PublisherService {
  constructor(
    private readonly registry: SubscriberRegistry,
    private readonly streamRepo: StreamRepository,
    private readonly manager: TenantsManager,
    private readonly logger?: Logger,
    /** Redis dédié à la publication Pub/Sub. Absent = dispatch local sans Redis. */
    private readonly publisherRedis?: Redis,
    private readonly metrics: MetricsRegistry = new MetricsRegistry(),
  ) {}

  /**
   * Publie un événement vers un ou plusieurs topics d'un tenant.
   *
   * Pour chaque topic :
   * 1. Persiste l'événement dans Redis Stream (si le tenant est connu).
   * 2. En mode multi-instances : publie sur `hubo:pubsub:{tenantId}:{topic}` via Redis Pub/Sub.
   *    Chaque instance reçoit le message et dispatche localement via son {@link SubscriberRegistry}.
   *    En mode standalone : dispatche directement dans le registry local.
   *
   * @returns L'identifiant (uuidv7) de l'événement créé.
   */
  async publish(
    tenantId: string,
    topics: string[],
    data: Record<string, unknown>,
    options: PublishOptions,
  ): Promise<string> {
    const start = performance.now()
    const eventId = options.id ?? uuidv7()
    const tenant = this.manager.getTenant(tenantId)

    const event: SSEEvent = {
      id: eventId,
      data,
      ...(options.retry !== undefined ? { retry: options.retry } : {}),
    }

    await Promise.all(
      topics.map(async (topic) => {
        const topicKey = `${tenantId}:${topic}`
        const streamKey = `hubo:stream:${topicKey}`

        if (tenant) {
          await this.streamRepo.xadd(
            streamKey,
            eventId,
            data,
            tenant.maxStreamLength,
            tenant.streamTtl,
          )
        }

        if (this.publisherRedis) {
          await this.publisherRedis.publish(`hubo:pubsub:${topicKey}`, JSON.stringify(event))
        } else {
          this.registry.dispatch(topicKey, event)
        }
      }),
    )

    this.metrics.increment('hubo_events_published_total', { tenant: tenantId })
    this.metrics.recordLatency(performance.now() - start)
    this.logger?.info({ tenant_id: tenantId, event_id: eventId, topics }, 'event published')

    return eventId
  }
}
