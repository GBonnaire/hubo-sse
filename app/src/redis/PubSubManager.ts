import type { Redis } from 'ioredis'
import type { SubscriberRegistry, SSEEvent } from '../subscriber/SubscriberRegistry.js'

/**
 * Écoute les messages Redis Pub/Sub publiés par {@link PublisherService} et les
 * dispatche aux connexions SSE locales via le {@link SubscriberRegistry}.
 *
 * Format du channel Redis : `hubo:pubsub:{tenantId}:{topic}`
 * Le topic peut lui-même contenir des `:` (ex: `orders:42:status`),
 * c'est pourquoi on joint `parts.slice(3)` plutôt que de prendre `parts[3]`.
 */
export class PubSubManager {
  constructor(
    private readonly subscriber: Redis,
    private readonly registry: SubscriberRegistry,
  ) {}

  /** Souscrit au pattern `hubo:pubsub:*` et démarre l'écoute des messages. */
  async start(): Promise<void> {
    await this.subscriber.psubscribe('hubo:pubsub:*')
    this.subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      this.handleMessage(channel, message)
    })
  }

  /**
   * Traite un message reçu depuis Redis Pub/Sub.
   * Ignore silencieusement les channels malformés ; loggue un warning pour le JSON invalide.
   */
  private handleMessage(channel: string, message: string): void {
    const parts = channel.split(':')
    // Minimum attendu : "hubo", "pubsub", tenantId, topic (4 segments)
    if (parts.length < 4) return
    const tenantId = parts[2]
    const topic = parts.slice(3).join(':')
    const topicKey = `${tenantId}:${topic}`

    try {
      const event = JSON.parse(message) as SSEEvent
      this.registry.dispatch(topicKey, event)
    } catch {
      console.warn(`[PubSubManager] Message JSON invalide sur le channel "${channel}"`)
    }
  }

  /** Se désabonne du pattern Redis Pub/Sub. */
  async stop(): Promise<void> {
    await this.subscriber.punsubscribe('hubo:pubsub:*')
  }
}
