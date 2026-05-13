import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generateKeyPair, exportSPKI, exportPKCS8, SignJWT } from 'jose'
import { PrismaClient } from '@prisma/client'
import { TenantsManager } from '../tenants/TenantsManager.js'
import { verifyPublisherJwt, verifySubscriberJwt } from './verifyJwt.js'

const prisma = new PrismaClient()
let publicKeyPem: string
let privateKeyPem: string
let otherPrivateKey: CryptoKey

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const { privateKey: otherPriv } = await generateKeyPair('RS256', { extractable: true })
  publicKeyPem = await exportSPKI(publicKey)
  privateKeyPem = await exportPKCS8(privateKey)
  otherPrivateKey = otherPriv

  await prisma.tenant.deleteMany({ where: { appId: 'rs256-test' } })
  await prisma.tenant.create({
    data: {
      appId: 'rs256-test',
      secret: '',
      algorithm: 'RS256',
      publicKey: publicKeyPem,
      origins: [],
    },
  })
})

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { appId: 'rs256-test' } })
  await prisma.$disconnect()
})

async function signToken(privateKey: CryptoKey, payload: Record<string, unknown>) {
  const { importPKCS8 } = await import('jose')
  const key = typeof privateKey === 'string'
    ? await importPKCS8(privateKey, 'RS256')
    : privateKey

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key)
}

describe('RS256 support (AC: 1, 2)', () => {
  it('AC1 : JWT RS256 avec clé privée correcte → autorisé (publish)', async () => {
    const { importPKCS8 } = await import('jose')
    const privKey = await importPKCS8(privateKeyPem, 'RS256')

    const token = await new SignJWT({
      iss: 'rs256-test',
      mode: 'publish',
      topics: ['orders'],
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privKey)

    const manager = new TenantsManager(prisma)
    await manager.load()

    const payload = await verifyPublisherJwt(`Bearer ${token}`, manager)
    expect(payload.iss).toBe('rs256-test')
    expect(payload.mode).toBe('publish')
  })

  it('AC1 : JWT RS256 avec clé privée correcte → autorisé (subscribe)', async () => {
    const { importPKCS8 } = await import('jose')
    const privKey = await importPKCS8(privateKeyPem, 'RS256')

    const token = await new SignJWT({
      iss: 'rs256-test',
      mode: 'subscribe',
      topics: ['orders'],
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privKey)

    const manager = new TenantsManager(prisma)
    await manager.load()

    const payload = await verifySubscriberJwt(
      { authorization: `Bearer ${token}` },
      {},
      manager,
    )
    expect(payload.iss).toBe('rs256-test')
  })

  it('AC2 : JWT RS256 avec mauvaise clé privée → 401 invalid_token', async () => {
    const token = await new SignJWT({
      iss: 'rs256-test',
      mode: 'publish',
      topics: ['orders'],
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(otherPrivateKey)

    const manager = new TenantsManager(prisma)
    await manager.load()

    await expect(verifyPublisherJwt(`Bearer ${token}`, manager)).rejects.toMatchObject({
      code: 'invalid_token',
      status: 401,
    })
  })
})
