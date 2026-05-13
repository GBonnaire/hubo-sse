# Guide d'intégration Next.js 14+ (App Router)

En moins de 30 minutes, affichez des événements temps réel dans vos composants React via Hubo SSE.

## Prérequis

- **Next.js** 14+ avec App Router
- Un hub Hubo opérationnel (voir [README](../README.md))
- `npm install jose` (déjà présent si vous utilisez Next-Auth)

---

## Variables d'environnement

```env
# .env.local
HUBO_URL=https://hub.example.com           # Server-side only
HUBO_APP_ID=my-nextjs-app
HUBO_SECRET=my-secret-minimum-32-chars-long

NEXT_PUBLIC_HUBO_URL=https://hub.example.com  # Exposed to browser
```

---

## Route API — Génération du subscriber token

```typescript
// app/api/hubo-token/route.ts
import { SignJWT } from 'jose'
import { auth } from '@/auth' // Next-Auth ou votre système d'auth

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const userId = session.user.id
  const secret = new TextEncoder().encode(process.env.HUBO_SECRET!)

  const token = await new SignJWT({
    iss: process.env.HUBO_APP_ID,
    mode: 'subscribe',
    topics: [`users:${userId}:*`, 'global:*'],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(secret)

  return Response.json({ token, expiresIn: 3600 })
}
```

---

## Hook `useHuboSubscription`

```typescript
// hooks/useHuboSubscription.ts
'use client'
import { useEffect, useRef, useState, useCallback } from 'react'

export interface HuboEvent<T = unknown> {
  id: string
  type?: string
  data: T
}

export function useHuboSubscription<T = unknown>(topics: string[]) {
  const [events, setEvents] = useState<HuboEvent<T>[]>([])
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const esRef = useRef<EventSource | null>(null)
  const cancelledRef = useRef(false)

  const connect = useCallback(async () => {
    if (cancelledRef.current || topics.length === 0) return

    try {
      const res = await fetch('/api/hubo-token')
      if (!res.ok || cancelledRef.current) return
      const { token } = await res.json() as { token: string }

      const lastEventId = localStorage.getItem('hubo_lastEventId')
      const url = new URL(`${process.env.NEXT_PUBLIC_HUBO_URL}/subscribe`)
      url.searchParams.set('topics', topics.join(','))
      url.searchParams.set('authorization', token)
      if (lastEventId) url.searchParams.set('lastEventId', lastEventId)

      const es = new EventSource(url.toString())
      esRef.current = es

      es.onopen = () => setStatus('connected')

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as T
          if (event.lastEventId) {
            localStorage.setItem('hubo_lastEventId', event.lastEventId)
          }
          setEvents((prev) => [...prev, { id: event.lastEventId, data }])
        } catch {
          // ignore malformed events
        }
      }

      es.addEventListener('token.expired', () => {
        es.close()
        setStatus('connecting')
        if (!cancelledRef.current) connect()
      })

      es.onerror = () => {
        setStatus('disconnected')
        // EventSource retries automatically on network errors
      }
    } catch {
      setStatus('disconnected')
    }
  }, [topics.join(',')])

  useEffect(() => {
    cancelledRef.current = false
    connect()
    return () => {
      cancelledRef.current = true
      esRef.current?.close()
    }
  }, [connect])

  const clearEvents = useCallback(() => setEvents([]), [])

  return { events, status, clearEvents }
}
```

---

## Server Action — Publication depuis Next.js

```typescript
// app/actions/notify.ts
'use server'
import { SignJWT } from 'jose'
import { auth } from '@/auth'

export async function notifyUser(userId: string, message: string): Promise<void> {
  const secret = new TextEncoder().encode(process.env.HUBO_SECRET!)

  const token = await new SignJWT({
    iss: process.env.HUBO_APP_ID,
    mode: 'publish',
    topics: [`users:${userId}:*`],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .sign(secret)

  const res = await fetch(`${process.env.HUBO_URL}/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topics: [`users:${userId}:notifications`],
      data: { message, timestamp: Date.now() },
    }),
  })

  if (!res.ok) {
    throw new Error(`Hubo publish failed: ${res.status}`)
  }
}
```

---

## Composant React complet

```tsx
// app/components/NotificationFeed.tsx
'use client'
import { useHuboSubscription } from '@/hooks/useHuboSubscription'
import { useSession } from 'next-auth/react'

interface Notification {
  message: string
  timestamp: number
}

export function NotificationFeed() {
  const { data: session } = useSession()
  const userId = session?.user?.id

  const { events, status } = useHuboSubscription<Notification>(
    userId ? [`users:${userId}:notifications`] : [],
  )

  if (!userId) return null

  return (
    <div className="notification-feed">
      <div className={`status status--${status}`}>
        {status === 'connected' ? '● En ligne' : '○ Reconnexion...'}
      </div>
      <ul>
        {events.map((event, i) => (
          <li key={event.id || i}>
            <span className="timestamp">
              {new Date(event.data.timestamp).toLocaleTimeString()}
            </span>
            {event.data.message}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

---

## Gestion avancée : replay après déconnexion

Le hook stocke automatiquement `hubo_lastEventId` dans `localStorage`. Lors d'une reconnexion (rafraîchissement de page ou perte réseau), les events manqués sont rejoués depuis Redis Streams via le paramètre `lastEventId`.

Pour réinitialiser le replay :

```typescript
const { events, clearEvents } = useHuboSubscription(topics)

// Effacer les events et réinitialiser le lastEventId
const handleReset = () => {
  localStorage.removeItem('hubo_lastEventId')
  clearEvents()
}
```

---

## Exemple : Dashboard temps réel

```tsx
// app/dashboard/page.tsx (Server Component)
import { NotificationFeed } from '@/components/NotificationFeed'
import { OrderStatusWidget } from '@/components/OrderStatusWidget'

export default function DashboardPage() {
  return (
    <main>
      <h1>Dashboard</h1>
      <NotificationFeed />
      <OrderStatusWidget orderId={42} />
    </main>
  )
}
```

```tsx
// app/components/OrderStatusWidget.tsx
'use client'
import { useHuboSubscription } from '@/hooks/useHuboSubscription'

interface OrderStatus {
  status: string
  updatedAt: number
}

export function OrderStatusWidget({ orderId }: { orderId: number }) {
  const { events, status } = useHuboSubscription<OrderStatus>([
    `orders:${orderId}:status`,
  ])

  const latest = events.at(-1)

  return (
    <div>
      <p>Connexion : {status}</p>
      {latest ? (
        <p>Statut commande #{orderId} : <strong>{latest.data.status}</strong></p>
      ) : (
        <p>En attente de mises à jour...</p>
      )}
    </div>
  )
}
```
