import type { ServerResponse } from 'node:http'
import type { SSEEvent } from './SubscriberRegistry.js'

/** Délai entre deux commentaires `: ping` pour maintenir la connexion vivante. */
const HEARTBEAT_INTERVAL_MS = 20_000

/**
 * Représente une connexion SSE active vers un client.
 *
 * Cycle de vie :
 * - À la construction, démarre un heartbeat (`ping` toutes les 20s) et planifie
 *   la fermeture automatique à l'expiration du JWT (`exp`).
 * - `send()` réinitialise le heartbeat à chaque événement (évite les pings inutiles).
 * - `close()` annule les deux timers et termine la réponse HTTP proprement.
 * - `sendTokenExpired()` et `sendShutdown()` envoient l'événement SSE approprié
 *   puis appellent `close()`.
 *
 * Les timers sont `unref`-és pour ne pas bloquer le process Node.js si toutes
 * les connexions actives sont fermées.
 */
export class SSEConnection {
  readonly id: string
  readonly tenantId: string

  private readonly response: ServerResponse
  private readonly exp: number
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private expirationTimer: ReturnType<typeof setTimeout> | null = null

  constructor(response: ServerResponse, tenantId: string, exp: number) {
    this.response = response
    this.tenantId = tenantId
    this.exp = exp
    this.id = crypto.randomUUID()
    this.startHeartbeat()
    this.scheduleExpiration()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.sendComment('ping')
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private scheduleExpiration(): void {
    const msUntilExp = this.exp * 1000 - Date.now()
    if (msUntilExp <= 0) {
      setImmediate(() => { this.sendTokenExpired() })
      return
    }
    this.expirationTimer = setTimeout(() => {
      this.sendTokenExpired()
    }, msUntilExp)
    this.expirationTimer.unref?.()
  }

  send(event: SSEEvent): void {
    this.startHeartbeat()
    const lines: string[] = []
    lines.push(`id: ${event.id}`)
    if (event.event) lines.push(`event: ${event.event}`)
    lines.push(`data: ${JSON.stringify(event.data)}`)
    if (event.retry) lines.push(`retry: ${event.retry}`)
    this.response.write(lines.join('\n') + '\n\n')
  }

  sendComment(comment: string): void {
    this.response.write(`: ${comment}\n\n`)
  }

  sendTokenExpired(): void {
    this.response.write('event: token.expired\ndata: {}\n\n')
    this.close()
  }

  sendShutdown(): void {
    this.response.write('event: server.shutdown\ndata: {}\n\n')
    this.close()
  }

  close(): void {
    this.stopHeartbeat()
    if (this.expirationTimer) {
      clearTimeout(this.expirationTimer)
      this.expirationTimer = null
    }
    try { this.response.end() } catch { /* already closed */ }
  }
}
