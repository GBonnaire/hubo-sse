import type { Redis } from 'ioredis'
import type { SSEEvent } from '../subscriber/SubscriberRegistry.js'

/**
 * Couche d'accès aux Redis Streams utilisés pour le replay d'événements SSE.
 *
 * Chaque stream correspond à un topic d'un tenant :
 * clé Redis = `hubo:stream:{tenantId}:{topic}`
 *
 * Structure d'une entrée de stream (champs Redis) :
 * - `id`        : identifiant métier de l'événement (uuidv7)
 * - `data`      : payload JSON sérialisé
 * - `timestamp` : epoch ms à l'instant de la publication
 */
export class StreamRepository {
  constructor(private readonly redis: Redis) {}

  /**
   * Ajoute un événement dans le stream Redis avec troncature et TTL.
   * Utilise un pipeline pour atomicité XADD + EXPIRE.
   *
   * @param maxLen      Nombre maximum d'entrées conservées dans le stream (MAXLEN ~)
   * @param ttlSeconds  Durée de vie du stream en secondes
   */
  async xadd(
    streamKey: string,
    eventId: string,
    data: Record<string, unknown>,
    maxLen: number,
    ttlSeconds: number,
  ): Promise<void> {
    const serializedData = JSON.stringify(data)
    const timestamp = Date.now().toString()

    await this.redis
      .pipeline()
      .xadd(streamKey, 'MAXLEN', maxLen, '*', 'id', eventId, 'data', serializedData, 'timestamp', timestamp)
      .expire(streamKey, ttlSeconds)
      .exec()
  }

  /**
   * Retourne les événements postérieurs à `lastEventId` pour le replay à la reconnexion.
   * Si `lastEventId` est introuvable dans le stream (TTL expiré, stream tronqué),
   * retourne tous les événements disponibles.
   */
  async xrange(streamKey: string, lastEventId: string): Promise<SSEEvent[]> {
    const entries = await this.redis.xrange(streamKey, '-', '+')
    const foundIndex = entries.findIndex(([, fields]) => this.getField(fields, 'id') === lastEventId)
    const startIndex = foundIndex === -1 ? 0 : foundIndex + 1
    return entries.slice(startIndex).map(([, fields]) => this.parseEntry(fields))
  }

  /** Recherche un champ dans le tableau plat clé/valeur retourné par Redis. */
  private getField(fields: string[], key: string): string | undefined {
    const idx = fields.indexOf(key)
    return idx !== -1 ? fields[idx + 1] : undefined
  }

  /** Convertit le tableau plat Redis en objet {@link SSEEvent}. */
  private parseEntry(fields: string[]): SSEEvent {
    const map: Record<string, string> = {}
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i]
      const value = fields[i + 1]
      if (key !== undefined && value !== undefined) map[key] = value
    }
    const id = map['id']
    if (!id) throw new Error(`StreamRepository: entrée corrompue — champ "id" manquant (fields: ${JSON.stringify(fields)})`)
    return { id, data: JSON.parse(map['data'] ?? 'null') }
  }
}
