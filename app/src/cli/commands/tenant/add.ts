import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { importSPKI } from 'jose'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../../db/prisma.js'

function generateSecret(): string {
  return randomBytes(32).toString('hex')
}

function printTenantTable(tenant: {
  appId: string
  algorithm: string
  secret: string
  publicKey: string | null
  origins: string[]
  streamTtl: number | null
  maxStreamLength: number | null
}, secretGenerated: boolean): void {
  const rows: { Champ: string; Valeur: string }[] = [
    { Champ: 'App ID',            Valeur: tenant.appId },
    { Champ: 'Algorithme',        Valeur: tenant.algorithm },
    { Champ: 'Secret',            Valeur: tenant.secret || '—' },
    { Champ: 'Clé publique',      Valeur: tenant.publicKey ? tenant.publicKey.slice(0, 40) + '…' : '—' },
    { Champ: 'Origins',           Valeur: tenant.origins.length ? tenant.origins.join(', ') : '(toutes)' },
    { Champ: 'Stream TTL (s)',    Valeur: tenant.streamTtl != null ? String(tenant.streamTtl) : 'défaut' },
    { Champ: 'Max stream length', Valeur: tenant.maxStreamLength != null ? String(tenant.maxStreamLength) : 'défaut' },
  ]

  console.log(`\nTenant '${tenant.appId}' créé avec succès.\n`)
  console.table(rows)

  if (secretGenerated) {
    console.log(`  Secret généré automatiquement — conservez-le, il ne sera plus affiché.\n`)
  }
}

export async function tenantAddCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'app-id':            { type: 'string' },
      'secret':            { type: 'string' },
      'origins':           { type: 'string', multiple: true },
      'algorithm':         { type: 'string', default: 'HS256' },
      'public-key':        { type: 'string' },
      'stream-ttl':        { type: 'string' },
      'max-stream-length': { type: 'string' },
    },
  })

  if (!values['app-id']) {
    console.error('Error: --app-id is required')
    process.exit(1)
    return
  }

  const algorithm = values['algorithm'] ?? 'HS256'

  if (algorithm === 'RS256') {
    if (!values['public-key']) {
      console.error('Error: --public-key is required for RS256')
      process.exit(1)
      return
    }
    try {
      await importSPKI(values['public-key'], 'RS256')
    } catch {
      console.error('Error: Invalid RSA public key (expected SPKI PEM format)')
      process.exit(1)
      return
    }
  }

  const secretGenerated = algorithm === 'HS256' && !values['secret']
  const secret = values['secret'] ?? (algorithm === 'HS256' ? generateSecret() : '')

  const data: Prisma.TenantCreateInput = {
    appId:     values['app-id'] as string,
    secret,
    algorithm,
    origins:   values['origins'] ?? [],
    publicKey: values['public-key'] ?? null,
    ...(values['stream-ttl']        ? { streamTtl:        parseInt(values['stream-ttl'], 10) }        : {}),
    ...(values['max-stream-length'] ? { maxStreamLength:  parseInt(values['max-stream-length'], 10) } : {}),
  }

  try {
    const tenant = await prisma.tenant.create({ data })
    printTenantTable(tenant, secretGenerated)
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2002') {
      console.error(`Error: Tenant '${values['app-id']}' already exists.`)
      process.exit(1)
    } else {
      throw err
    }
  }
}
