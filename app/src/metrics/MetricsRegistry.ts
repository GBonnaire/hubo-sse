export class MetricsRegistry {
  private counters = new Map<string, number>()
  private gauges = new Map<string, number>()
  private latencies: number[] = []

  increment(name: string, labels: Record<string, string> = {}): void {
    const key = this.labelKey(name, labels)
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1)
  }

  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.labelKey(name, labels)
    this.gauges.set(key, value)
  }

  recordLatency(ms: number): void {
    this.latencies.push(ms)
    if (this.latencies.length > 10_000) this.latencies.shift()
  }

  private labelKey(name: string, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')
    return labelStr ? `${name}{${labelStr}}` : name
  }

  serialize(): string {
    const lines: string[] = []
    for (const [key, value] of this.counters) {
      lines.push(`${key} ${value}`)
    }
    for (const [key, value] of this.gauges) {
      lines.push(`${key} ${value}`)
    }
    if (this.latencies.length > 0) {
      const sorted = [...this.latencies].sort((a, b) => a - b)
      const p = (q: number) => sorted[Math.floor(sorted.length * q)]
      lines.push(`hubo_publish_latency_ms{quantile="0.5"} ${p(0.5)}`)
      lines.push(`hubo_publish_latency_ms{quantile="0.95"} ${p(0.95)}`)
      lines.push(`hubo_publish_latency_ms{quantile="0.99"} ${p(0.99)}`)
    }
    return lines.join('\n')
  }

  reset(): void {
    this.counters.clear()
    this.gauges.clear()
    this.latencies = []
  }
}

