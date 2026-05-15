import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { VERSION } from '../config.js'
import type { ConnectionCounter } from '../subscriber/ConnectionCounter.js'
import { healthHandler } from './health.js'


type ServiceStatus = 'ok' | 'error'
type GlobalStatus  = 'ok' | 'degraded' | 'error'

const BADGE_LABEL: Record<GlobalStatus, string> = {
  ok:       'Opérationnel',
  degraded: 'Dégradé',
  error:    'Erreur',
}

const BADGE_COLORS: Record<GlobalStatus, { bg: string; border: string; color: string }> = {
  ok:       { bg: 'rgba(0,212,170,0.1)',  border: 'rgba(0,212,170,0.3)',  color: '#00d4aa' },
  degraded: { bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.3)', color: '#f59e0b' },
  error:    { bg: 'rgba(239,68,68,0.1)',  border: 'rgba(239,68,68,0.3)',  color: '#ef4444' },
}

const SERVICE_COLORS: Record<ServiceStatus, { color: string }> = {
  ok:    { color: '#00d4aa' },
  error: { color: '#ef4444' },
}

function renderBadge(status: GlobalStatus): string {
  const { bg, border, color } = BADGE_COLORS[status]
  const pulse = status === 'ok' ? ' style="animation:pulse 2s infinite"' : ''
  return `<div style="display:inline-flex;align-items:center;gap:0.6rem;padding:0.55rem 1.2rem;border-radius:20px;font-size:0.9rem;font-weight:600;margin-bottom:2rem;background:${bg};border:1px solid ${border};color:${color}">
    <span style="width:8px;height:8px;border-radius:50%;background:currentColor"${pulse}></span>
    ${BADGE_LABEL[status]}
  </div>`
}

function renderServiceRow(name: string, status: ServiceStatus): string {
  const { color } = SERVICE_COLORS[status]
  const label = status === 'ok' ? 'OK' : 'Erreur'
  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0.9rem;background:rgba(255,255,255,0.03);border:1px solid #2a2d3a;border-radius:8px;font-size:0.88rem">
    <span style="color:#7b7f96">${name}</span>
    <span style="display:flex;align-items:center;gap:0.4rem;font-weight:600;font-size:0.82rem;color:${color}">
      <span style="width:6px;height:6px;border-radius:50%;background:currentColor"></span>
      ${label}
    </span>
  </div>`
}

function renderPage(status: GlobalStatus, redis: ServiceStatus, database: ServiceStatus, version: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="10" />
  <title>Hubo — Hub SSE multi-tenant</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #e8eaf0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .card {
      text-align: center;
      padding: 3rem 4rem;
      background: #1a1d27;
      border: 1px solid #2a2d3a;
      border-radius: 12px;
      min-width: 340px;
    }
    footer {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 1rem 2rem;
      text-align: center;
      color: #7b7f96;
      font-size: 0.82rem;
      border-top: 1px solid #2a2d3a;
      background: #0f1117;
    }
    footer strong { color: #e8eaf0; }
    footer a { color: #6c63ff; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
    
    h1 { font-size: 2.8rem; font-weight: 800; letter-spacing: -1.5px; margin-bottom: 0.3rem; }
    h1 span { color: #6c63ff; }
    .tagline { color: #7b7f96; font-size: 0.95rem; margin-bottom: 2rem; }
    .services { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1.5rem; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  </style>
</head>
<body>
<div class="card">
  <h1>hu<span>bo</span></h1>
  <p class="tagline">Hub SSE — v${version}</p>

  ${renderBadge(status)}

  <div class="services">
    ${renderServiceRow('SSE Server', status === 'error' ? 'error' : 'ok')}
    ${renderServiceRow('Redis', redis)}
    ${renderServiceRow('Base de données', database)}
  </div>
</div>
<footer>
  <p>
    <strong>Hubo</strong>
     — Hub SSE
     — Développé par <a href="https://www.gbonnaire.fr">GBonnaire.fr</a>
     — <a href="https://github.com/GBonnaire/hubo-sse">GitHub</a>
  </p>
</footer>
</body>
</html>`
}

export async function homeRoutes(
  fastify: FastifyInstance,
  opts: { config: AppConfig; counter?: ConnectionCounter },
): Promise<void> {
  fastify.get('/', async (_, reply) => {
    let status: GlobalStatus
    let redis: ServiceStatus    = 'error'
    let database: ServiceStatus = 'error'
    try {
      const health = await healthHandler(opts.config, opts.counter)
      status   = health.status
      redis    = health.redis
      database = health.database
    } catch {
      status = 'error'
    }

    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(renderPage(status, redis, database, VERSION))
  })
}
