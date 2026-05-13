import { parseArgs } from 'node:util'
import { getRedis } from '../../../redis/redis.js'

export async function tokenRevokeCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      jti: { type: 'string' },
      tenant: { type: 'string' },
      exp: { type: 'string' },
    },
  })

  if (!values.jti) {
    console.error('Error: --jti is required')
    process.exit(1)
    return
  }

  let ttl = 86400
  if (values.exp) {
    const expTs = parseInt(values.exp, 10)
    if (isNaN(expTs)) {
      console.error(`Error: --exp invalide : "${values.exp}" n'est pas un timestamp Unix`)
      process.exit(1)
      return
    }
    ttl = Math.max(1, expTs - Math.floor(Date.now() / 1000))
  }

  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const redis = getRedis(redisUrl)
  await redis.set(`hubo:jti:${values.jti}`, '1', 'EX', ttl)

  console.log(`Token JTI '${values.jti}' revoked (TTL: ${ttl}s).`)
}
