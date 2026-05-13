import Fastify from 'fastify'
import type { FastifyInstance, RawServerDefault } from 'fastify'
import type { IncomingMessage, ServerResponse } from 'node:http'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import pino from 'pino'
import type { Logger } from 'pino'
import dynamicCors from './plugins/cors.js'
import type { AppConfig } from './config.js'
import type { TenantsManager } from './tenants/TenantsManager.js'
import { getRedis } from './redis/redis.js'
import { StreamRepository } from './redis/StreamRepository.js'
import { SubscriberRegistry } from './subscriber/SubscriberRegistry.js'
import { PublisherService } from './publisher/PublisherService.js'
import { publishRoutes } from './routes/publish.js'
import { subscribeRoutes } from './routes/subscribe.js'
import { healthRoutes } from './routes/health.js'
import { metricsRoutes } from './routes/metrics.js'
import { homeRoutes } from './routes/home.js'
import { ConnectionCounter } from './subscriber/ConnectionCounter.js'
import { MetricsRegistry } from './metrics/MetricsRegistry.js'
import { PubSubManager } from './redis/PubSubManager.js'
import { createPubSubSubscriberRedis } from './redis/redis.js'

function buildLogger(config: AppConfig, loggerInstance?: Logger): Logger {
  if (loggerInstance) return loggerInstance

  const serializers = {
    req(req: { method: string; url?: string; hostname?: string; ip?: string }) {
      return {
        method: req.method,
        url: req.url?.replace(/([?&]authorization=)[^&]*/g, '$1[REDACTED]'),
        hostname: req.hostname,
        remoteAddress: req.ip,
      }
    },
    res(res: { statusCode: number }) {
      return { statusCode: res.statusCode }
    },
  }

  const base = {
    level: config.logLevel,
    redact: { paths: ['req.headers.authorization', 'req.query.authorization'], censor: '[REDACTED]' },
    serializers,
  }

  if (process.env.NODE_ENV === 'development') {
    return pino({ ...base, transport: { target: 'pino-pretty', options: { colorize: true } } })
  }
  return pino(base)
}

export async function buildApp(
  config: AppConfig,
  manager?: TenantsManager,
  loggerInstance?: Logger,
  subscriberReg?: SubscriberRegistry,
  metricsInstance?: MetricsRegistry,
): Promise<FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse<IncomingMessage>, Logger>> {
  const logger = buildLogger(config, loggerInstance)
  const app = Fastify({ loggerInstance: logger, bodyLimit: 1_048_576 })
  const metrics = metricsInstance ?? new MetricsRegistry()

  await app.register(helmet, {
    hsts: config.httpsRedirect,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'font-src': ["'self'", 'https:', 'data:'],
        'form-action': ["'self'"],
        'frame-ancestors': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        'script-src': ["'self'"],
        'script-src-attr': ["'none'"],
        'style-src': ["'self'", 'https:', "'unsafe-inline'"],
        ...(config.httpsRedirect ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
  })

  let counter: ConnectionCounter | undefined

  if (manager) {
    const redis = getRedis(config.redis)
    await app.register(rateLimit, { global: false, redis })

    await app.register(dynamicCors, { manager })

    const streamRepo = new StreamRepository(redis)
    const registry = subscriberReg ?? new SubscriberRegistry(metrics)
    counter = new ConnectionCounter(metrics)
    const publisherService = new PublisherService(registry, streamRepo, manager, logger, redis, metrics)
    await app.register(publishRoutes, { manager, publisherService, redis, metrics })
    await app.register(subscribeRoutes, { manager, registry, counter, streamRepo, redis, metrics })

    const pubSubSubscriber = createPubSubSubscriberRedis(config.redis)
    const pubSubManager = new PubSubManager(pubSubSubscriber, registry)
    await pubSubManager.start()

    app.addHook('onClose', async () => {
      await pubSubManager.stop()
    })
  } else {
    await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' })
  }

  await app.register(homeRoutes, { config, ...(counter ? { counter } : {}) })
  await app.register(healthRoutes, { config, ...(counter ? { counter } : {}) })
  await app.register(metricsRoutes, { config, metrics })

  if (config.httpsRedirect) {
    app.addHook('onRequest', (req, reply, done) => {
      if (req.headers['x-forwarded-proto'] === 'http') {
        const host = req.headers.host ?? 'localhost'
        void reply.redirect(`https://${host}${req.url}`, 301)
        return
      }
      done()
    })
  }

  app.setNotFoundHandler((_, reply) => {
    reply.code(404).send({ error: 'Not Found' })
  })

  app.setErrorHandler((error, _, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500
    if (statusCode === 500) app.log.error(error)
    const message = error instanceof Error ? error.message : 'Internal Server Error'
    reply.code(statusCode).send({ error: message })
  })

  return app
}
