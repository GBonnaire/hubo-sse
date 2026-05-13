import { MetricsRegistry } from '../metrics/MetricsRegistry.js'

export interface SSEEvent {
  id: string
  data: unknown
  event?: string
  retry?: number
}

export interface SSEConnection {
  id: string
  tenantId: string
  send(event: SSEEvent): void
  sendShutdown?(): void
}

/**
 * Registre en mémoire des connexions SSE actives, indexées par `topicKey`.
 *
 * `topicKey` = `"{tenantId}:{topic}"` (ex: `"my-app:orders:42:status"`).
 * Une même connexion peut être abonnée à plusieurs topics simultanément.
 */
export class SubscriberRegistry {
  private connections = new Map<string, Set<SSEConnection>>()

  constructor(private readonly metrics: MetricsRegistry = new MetricsRegistry()) {}

  subscribe(topicKey: string, connection: SSEConnection): void {
    if (!this.connections.has(topicKey)) {
      this.connections.set(topicKey, new Set())
    }
    this.connections.get(topicKey)!.add(connection)
  }

  unsubscribe(topicKey: string, connection: SSEConnection): void {
    this.connections.get(topicKey)?.delete(connection)
  }

  /**
   * Envoie `event` à toutes les connexions abonnées à `topicKey`.
   * L'envoi est synchrone et fire-and-forget : une erreur d'écriture sur une
   * connexion individuelle ne bloque pas les autres.
   */
  dispatch(topicKey: string, event: SSEEvent): void {
    const conns = this.connections.get(topicKey)
    if (!conns?.size) return
    for (const conn of conns) {
      conn.send(event)
      this.metrics.increment('hubo_events_delivered_total', { tenant: conn.tenantId })
    }
  }

  /**
   * Envoie `server.shutdown` à toutes les connexions puis vide le registre.
   * Appelé pendant le graceful shutdown avant de fermer le serveur HTTP.
   */
  notifyShutdown(): void {
    const allConnections = new Set<SSEConnection>()
    for (const conns of this.connections.values()) {
      for (const conn of conns) allConnections.add(conn)
    }
    for (const conn of allConnections) {
      conn.sendShutdown?.()
    }
    this.connections.clear()
  }
}

