import { SignJWT } from 'jose'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../app.js'
import { TenantsManager } from '../../tenants/TenantsManager.js'
import type { AppConfig } from '../../config.js'
import type { AddressInfo } from 'node:net'

export const prisma = new PrismaClient()

export const TEST_TENANT_A = {
  appId: 'integ-tenant-a',
  secret: 'integ-secret-tenant-a-minimum-32ch',
  algorithm: 'HS256' as const,
  rateLimitPublish: 5,
}

export const TEST_TENANT_B = {
  appId: 'integ-tenant-b',
  secret: 'integ-secret-tenant-b-minimum-32ch',
  algorithm: 'HS256' as const,
}

export const testConfig: AppConfig = {
  port: 0,
  redis: 'redis://redis:6379',
  database: 'mysql://admin:admin@db:3306/hubo',
  logLevel: 'error',
  httpsRedirect: false,
}

export async function setupTenants() {
  await prisma.tenant.deleteMany({ where: { appId: { in: [TEST_TENANT_A.appId, TEST_TENANT_B.appId] } } })
  await prisma.tenant.createMany({
    data: [TEST_TENANT_A, TEST_TENANT_B],
  })
}

export async function teardownTenants() {
  await prisma.tenant.deleteMany({ where: { appId: { in: [TEST_TENANT_A.appId, TEST_TENANT_B.appId] } } })
  await prisma.$disconnect()
}

export async function buildTestApp() {
  const manager = new TenantsManager(prisma)
  await manager.load()
  const app = await buildApp(testConfig, manager)
  await app.listen({ port: 0 })
  const port = (app.server.address() as AddressInfo).port
  return { app, port, manager }
}

export function makeToken(
  tenantId: string,
  secret: string,
  mode: 'publish' | 'subscribe',
  topics: string[],
  expiresIn: string | number = '1h',
) {
  return new SignJWT({ mode, topics })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setIssuer(tenantId)
    .sign(new TextEncoder().encode(secret))
}

export interface SSEMessage {
  event?: string
  data: string
  id?: string
}

export async function* readSSE(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<SSEMessage> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (!signal.aborted) {
      let done: boolean
      let value: Uint8Array | undefined
      try {
        ;({ done, value } = await reader.read())
      } catch {
        break // AbortError or network error — exit cleanly
      }
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        if (!block.trim()) continue
        const msg: Partial<SSEMessage> = {}
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue
          const colonIdx = line.indexOf(':')
          if (colonIdx === -1) continue
          const field = line.slice(0, colonIdx)
          const val = line.slice(colonIdx + 1).trimStart()
          if (field === 'data') msg.data = val
          else if (field === 'event') msg.event = val
          else if (field === 'id') msg.id = val
        }
        if (msg.data !== undefined) yield msg as SSEMessage
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

export async function firstSSEMessage(
  url: string,
  signal: AbortSignal,
): Promise<SSEMessage> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`SSE connect failed: ${res.status}`)
  for await (const msg of readSSE(res, signal)) {
    return msg
  }
  throw new Error('SSE stream ended without a message')
}
