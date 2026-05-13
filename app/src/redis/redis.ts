import { Redis } from 'ioredis'

let instance: Redis | null = null
// Non-singleton: each app instance needs its own subscribe-mode connection


export function getRedis(url: string): Redis {
  if (!instance) {
    instance = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
      lazyConnect: true,
    })
  }
  return instance
}

export function createPubSubSubscriberRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    lazyConnect: true,
  })
}

export async function closeRedis(): Promise<void> {
  if (instance) {
    await instance.quit()
    instance = null
  }
}
