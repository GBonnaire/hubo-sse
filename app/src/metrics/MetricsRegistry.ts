interface MetricDef {
  help: string
  type: 'counter' | 'gauge' | 'summary'
}

const KNOWN_METRICS: Record<string, MetricDef> = {
  hubo_events_published_total:   { help: 'Total events published',              type: 'counter' },
  hubo_jwt_errors_total:         { help: 'Total JWT validation errors',         type: 'counter' },
  hubo_connections_active:       { help: 'Active SSE connections',              type: 'gauge'   },
  hubo_publish_latency_ms:       { help: 'Publish latency in milliseconds',     type: 'summary' },
}

export class MetricsRegistry {
  private counters = new Map<string, number>()
  private gauges   = new Map<string, number>()
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

  private metricBaseName(key: string): string {
    return key.replace(/\{.*\}$/, '')
  }

  serialize(): string {
    const lines: string[] = []
    const emitted = new Set<string>()

    const emit = (key: string, value: number) => {
      const base = this.metricBaseName(key)
      if (!emitted.has(base)) {
        const def = KNOWN_METRICS[base]
        if (def) {
          lines.push(`# HELP ${base} ${def.help}`)
          lines.push(`# TYPE ${base} ${def.type}`)
        }
        emitted.add(base)
      }
      lines.push(`${key} ${value}`)
    }

    for (const [key, value] of this.counters) emit(key, value)
    for (const [key, value] of this.gauges)   emit(key, value)

    // Émet les métriques connues à 0 si jamais alimentées
    for (const [name, def] of Object.entries(KNOWN_METRICS)) {
      if (def.type === 'summary') continue
      if (!emitted.has(name)) {
        lines.push(`# HELP ${name} ${def.help}`)
        lines.push(`# TYPE ${name} ${def.type}`)
        lines.push(`${name} 0`)
      }
    }

    if (this.latencies.length > 0) {
      const base = 'hubo_publish_latency_ms'
      if (!emitted.has(base)) {
        const def = KNOWN_METRICS[base]!
        lines.push(`# HELP ${base} ${def.help}`)
        lines.push(`# TYPE ${base} ${def.type}`)
      }
      const sorted = [...this.latencies].sort((a, b) => a - b)
      const p = (q: number) => sorted[Math.floor(sorted.length * q)]
      lines.push(`${base}{quantile="0.5"}  ${p(0.5)}`)
      lines.push(`${base}{quantile="0.95"} ${p(0.95)}`)
      lines.push(`${base}{quantile="0.99"} ${p(0.99)}`)
    }

    return lines.join('\n') + '\n'
  }

  reset(): void {
    this.counters.clear()
    this.gauges.clear()
    this.latencies = []
  }
}
