import { parseArgs } from 'node:util'
import { startCommand } from './commands/start.js'
import { statusCommand } from './commands/status.js'
import { tenantAddCommand } from './commands/tenant/add.js'
import { tenantListCommand } from './commands/tenant/list.js'
import { tenantRemoveCommand } from './commands/tenant/remove.js'
import { tokenRevokeCommand } from './commands/token/revoke.js'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: 'string', short: 'p' },
  },
  allowPositionals: true,
  strict: false,
})

const command = positionals[0]
const portArg = typeof values.port === 'string' ? values.port : undefined

switch (command) {
  case 'start':
    await startCommand({
      ...(portArg !== undefined ? { port: portArg } : {}),
    })
    break
  case 'status':
    await statusCommand(portArg ? parseInt(portArg, 10) : undefined)
    break
  case 'tenant': {
    const tenantCommand = positionals[1]
    switch (tenantCommand) {
      case 'add':
        await tenantAddCommand(process.argv.slice(4))
        break
      case 'list':
        await tenantListCommand(process.argv.slice(4))
        break
      case 'remove':
        await tenantRemoveCommand(process.argv.slice(4))
        break
      default:
        console.error(`Sous-commande tenant inconnue : ${tenantCommand ?? '(aucune)'}`)
        console.error('Usage: hubo tenant <add|list|remove> [options]')
        process.exit(1)
    }
    break
  }
  case 'token': {
    const tokenCommand = positionals[1]
    switch (tokenCommand) {
      case 'revoke':
        await tokenRevokeCommand(process.argv.slice(4))
        break
      default:
        console.error(`Sous-commande token inconnue : ${tokenCommand ?? '(aucune)'}`)
        console.error('Usage: hubo token <revoke> [options]')
        process.exit(1)
    }
    break
  }
  default:
    console.error(`Commande inconnue : ${command ?? '(aucune)'}`)
    console.error('Usage: hubo <start|status|tenant|token> [options]')
    process.exit(1)
}
