import { MetricsRegistry } from '../metrics/MetricsRegistry.js'

const DEFAULT_MAX_PER_SESSION = 10

export class ConnectionCounter {
  private tenantCounts = new Map<string, number>()
  private sessionCounts = new Map<string, number>()

  constructor(private readonly metrics: MetricsRegistry = new MetricsRegistry()) {}

  increment(tenantId: string, sessionId: string | undefined, maxTenant: number): boolean {
    const tenantCount = this.tenantCounts.get(tenantId) ?? 0
    if (tenantCount >= maxTenant) return false

    if (sessionId) {
      const sessionKey = `${tenantId}:${sessionId}`
      const sessionCount = this.sessionCounts.get(sessionKey) ?? 0
      if (sessionCount >= DEFAULT_MAX_PER_SESSION) return false
      this.sessionCounts.set(sessionKey, sessionCount + 1)
    }

    const newCount = tenantCount + 1
    this.tenantCounts.set(tenantId, newCount)
    this.metrics.gauge('hubo_connections_active', newCount, { tenant: tenantId })
    return true
  }

  decrement(tenantId: string, sessionId: string | undefined): void {
    const tenantCount = this.tenantCounts.get(tenantId) ?? 0
    if (tenantCount > 0) {
      const newCount = tenantCount - 1
      this.tenantCounts.set(tenantId, newCount)
      this.metrics.gauge('hubo_connections_active', newCount, { tenant: tenantId })
    }

    if (sessionId) {
      const sessionKey = `${tenantId}:${sessionId}`
      const sessionCount = this.sessionCounts.get(sessionKey) ?? 0
      if (sessionCount > 0) this.sessionCounts.set(sessionKey, sessionCount - 1)
    }
  }

  getCount(tenantId: string): number {
    return this.tenantCounts.get(tenantId) ?? 0
  }

  getSessionCount(tenantId: string, sessionId: string): number {
    return this.sessionCounts.get(`${tenantId}:${sessionId}`) ?? 0
  }

  totalCount(): number {
    let total = 0
    for (const count of this.tenantCounts.values()) total += count
    return total
  }
}
