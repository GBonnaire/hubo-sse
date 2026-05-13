import { parseArgs } from 'node:util'
import { prisma } from '../../../db/prisma.js'

export async function tenantListCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { format: { type: 'string', default: 'table' } },
  })

  const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } })

  if (tenants.length === 0) {
    console.log('No tenants configured.')
    return
  }

  if (values.format === 'json') {
    const redacted = tenants.map(t => ({
      ...t,
      secret: '[REDACTED]',
      publicKey: t.publicKey ? '[REDACTED]' : null,
    }))
    console.log(JSON.stringify(redacted, null, 2))
    return
  }

  console.table(tenants.map(t => ({
    app_id: t.appId,
    algorithm: t.algorithm,
    origins: (t.origins as string[]).join(', ') || '(none)',
    stream_ttl: t.streamTtl,
    created_at: t.createdAt.toISOString().split('T')[0],
  })))
}
