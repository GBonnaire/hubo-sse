import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'

const DEFAULT_PORT = 3000

export async function statusCommand(port = DEFAULT_PORT): Promise<void> {
  const pidFile = path.join(os.homedir(), '.hubo', 'hubo.pid')

  try {
    const raw = await fs.readFile(pidFile, 'utf8')
    const pid = parseInt(raw.trim(), 10)

    if (isNaN(pid)) {
      console.log('Status: stopped (invalid pid file)')
      return
    }

    process.kill(pid, 0)

    let uptime = 'N/A'
    let connections = 'N/A'

    try {
      const res = await fetch(`http://localhost:${port}/health`)
      const health = await res.json() as { uptime?: number; connections?: number }
      uptime = String(health.uptime ?? 'N/A')
      connections = String(health.connections ?? 'N/A')
    } catch {
      // health check failed but process is running
    }

    console.table({ status: 'running', pid, uptime, connections })
  } catch {
    console.log('Status: stopped')
  }
}
