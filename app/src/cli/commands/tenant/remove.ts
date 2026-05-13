import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { prisma } from '../../../db/prisma.js'

async function signalHubReload(): Promise<void> {
  try {
    const pidFile = path.join(os.homedir(), '.hubo', 'hubo.pid')
    const raw = await fs.readFile(pidFile, 'utf8')
    const pid = parseInt(raw.trim(), 10)
    if (!isNaN(pid)) {
      process.kill(pid, 'SIGHUP')
      console.log('Hub cache reloaded.')
    }
  } catch {
    console.log('Hub process not found — cache will be reloaded on next startup.')
  }
}

export async function tenantRemoveCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { 'app-id': { type: 'string' } },
  })

  if (!values['app-id']) {
    console.error('Error: --app-id is required')
    process.exit(1)
    return
  }

  try {
    await prisma.tenant.delete({ where: { appId: values['app-id'] } })
    console.log(`Tenant '${values['app-id']}' removed successfully.`)
    await signalHubReload()
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2025') {
      console.error(`Error: Tenant '${values['app-id']}' not found.`)
      process.exit(1)
    } else {
      throw err
    }
  }
}
