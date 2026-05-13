import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { loadConfig } from '../../config.js'
import { buildApp } from '../../app.js'
import { TenantsManager } from '../../tenants/TenantsManager.js'
import { SubscriberRegistry } from '../../subscriber/SubscriberRegistry.js'
import { MetricsRegistry } from '../../metrics/MetricsRegistry.js'
import { closeRedis } from '../../redis/redis.js'
import { prisma } from '../../db/prisma.js'

export interface StartArgs {
  port?: string
}

export async function startCommand(args: StartArgs): Promise<void> {
  const config = loadConfig()

  if (args.port) config.port = parseInt(args.port, 10)

  const manager = new TenantsManager()
  const metrics = new MetricsRegistry()
  const registry = new SubscriberRegistry(metrics)
  const app = await buildApp(config, manager, undefined, registry, metrics)

  try {
    await manager.load()
  } catch (err) {
    console.error(`Erreur chargement tenants : ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const tenantCount = manager.getAllTenants().length

  process.on('SIGHUP', () => {
    manager.reload().catch(err => app.log.error(err, 'tenant reload failed'))
  })

  setInterval(() => {
    manager.reload().catch(err => app.log.error(err, 'tenant reload failed'))
  }, 60_000).unref()

  try {
    await app.listen({ port: config.port, host: '::' })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }

  app.log.info({ port: config.port, tenants: tenantCount }, 'Hubo started')

  const pidDir = path.join(os.homedir(), '.hubo')
  await fs.mkdir(pidDir, { recursive: true })
  const pidFile = path.join(pidDir, 'hubo.pid')
  await fs.writeFile(pidFile, String(process.pid))

  let isShuttingDown = false

  async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) return
    isShuttingDown = true

    app.log.info({ signal }, 'Graceful shutdown initiated')

    const forceExitTimer = setTimeout(() => {
      app.log.error('Graceful shutdown timeout — forcing exit')
      process.exit(1)
    }, 30_000)
    forceExitTimer.unref()

    try {
      await app.close()
      registry.notifyShutdown()
      await closeRedis()
      await prisma.$disconnect()
      app.log.info('Graceful shutdown complete')
      clearTimeout(forceExitTimer)
      await fs.unlink(pidFile).catch(() => undefined)
      process.exit(0)
    } catch (err) {
      app.log.error(err, 'Error during graceful shutdown')
      process.exit(1)
    }
  }

  process.once('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(err => { console.error('SIGTERM handler error', err); process.exit(1) }) })
  process.once('SIGINT',  () => { gracefulShutdown('SIGINT').catch(err => { console.error('SIGINT handler error', err); process.exit(1) }) })
}
