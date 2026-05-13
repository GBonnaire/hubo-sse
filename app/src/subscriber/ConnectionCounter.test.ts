import { describe, it, expect, beforeEach } from 'vitest'
import { ConnectionCounter } from './ConnectionCounter.js'

// ─── Story 4.5 : Rate limiting des connexions simultanées ───────────────────

describe('ConnectionCounter — Story 4.5', () => {
  let counter: ConnectionCounter

  beforeEach(() => {
    counter = new ConnectionCounter()
  })

  it('incrément sous la limite → true', () => {
    expect(counter.increment('tenant1', undefined, 500)).toBe(true)
  })

  it('501ème connexion pour un tenant avec limite 500 → false', () => {
    for (let i = 0; i < 500; i++) {
      counter.increment('tenant1', undefined, 500)
    }
    expect(counter.increment('tenant1', undefined, 500)).toBe(false)
  })

  it('10 connexions même session → OK ; 11ème → false', () => {
    for (let i = 0; i < 10; i++) {
      expect(counter.increment('tenant1', 'sess-abc', 500)).toBe(true)
    }
    expect(counter.increment('tenant1', 'sess-abc', 500)).toBe(false)
  })

  it('décrémentation → connexion suivante acceptée', () => {
    counter.increment('tenant1', undefined, 1)
    expect(counter.increment('tenant1', undefined, 1)).toBe(false)

    counter.decrement('tenant1', undefined)
    expect(counter.increment('tenant1', undefined, 1)).toBe(true)
  })

  it('tenant A à la limite → tenant B non affecté', () => {
    for (let i = 0; i < 2; i++) {
      counter.increment('tenantA', undefined, 2)
    }
    expect(counter.increment('tenantA', undefined, 2)).toBe(false)
    expect(counter.increment('tenantB', undefined, 2)).toBe(true)
  })

  it('getCount retourne le nombre de connexions actives du tenant', () => {
    counter.increment('tenant1', undefined, 10)
    counter.increment('tenant1', undefined, 10)
    expect(counter.getCount('tenant1')).toBe(2)
  })

  it('decrement sans connexion ne lance pas d\'erreur et reste à 0', () => {
    expect(() => counter.decrement('tenant1', undefined)).not.toThrow()
    expect(counter.getCount('tenant1')).toBe(0)
  })

  it('décrémentation session → compteur session réduit', () => {
    counter.increment('tenant1', 'sess-1', 100)
    counter.increment('tenant1', 'sess-1', 100)
    counter.decrement('tenant1', 'sess-1')

    expect(counter.getSessionCount('tenant1', 'sess-1')).toBe(1)
  })

  it('session_id absent → limite par session non appliquée', () => {
    for (let i = 0; i < 20; i++) {
      expect(counter.increment('tenant1', undefined, 100)).toBe(true)
    }
    expect(counter.getCount('tenant1')).toBe(20)
  })
})
