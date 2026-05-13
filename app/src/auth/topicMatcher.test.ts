import { describe, it, expect } from 'vitest'
import { matchesTopic, isTopicAllowed, areTopicsAllowed } from './topicMatcher.js'

describe('matchesTopic', () => {
  it('correspondance exacte → autorisé', () => {
    expect(matchesTopic('orders:42:status', 'orders:42:status')).toBe(true)
  })

  it('topic différent, pas de wildcard → refusé', () => {
    expect(matchesTopic('orders:42:status', 'orders:99:status')).toBe(false)
  })

  it('orders:* → orders:42:status autorisé', () => {
    expect(matchesTopic('orders:*', 'orders:42:status')).toBe(true)
  })

  it('orders:* → orders:99:events autorisé', () => {
    expect(matchesTopic('orders:*', 'orders:99:events')).toBe(true)
  })

  it('users:42:* → users:42:notifications autorisé', () => {
    expect(matchesTopic('users:42:*', 'users:42:notifications')).toBe(true)
  })

  it('users:42:* → users:99:notifications refusé', () => {
    expect(matchesTopic('users:42:*', 'users:99:notifications')).toBe(false)
  })

  it('chat:room:*:message → chat:room:general:message autorisé', () => {
    expect(matchesTopic('chat:room:*:message', 'chat:room:general:message')).toBe(true)
  })

  it('chat:room:*:message → chat:room:general:update refusé', () => {
    expect(matchesTopic('chat:room:*:message', 'chat:room:general:update')).toBe(false)
  })
})

describe('isTopicAllowed', () => {
  it('orders:42:status dans la liste → autorisé', () => {
    expect(isTopicAllowed('orders:42:status', ['orders:42:status'])).toBe(true)
  })

  it('orders:99:status sans wildcard → refusé', () => {
    expect(isTopicAllowed('orders:99:status', ['orders:42:status'])).toBe(false)
  })

  it('orders:* couvre orders:42:status ET orders:99:events', () => {
    expect(isTopicAllowed('orders:42:status', ['orders:*'])).toBe(true)
    expect(isTopicAllowed('orders:99:events', ['orders:*'])).toBe(true)
  })
})

describe('areTopicsAllowed', () => {
  it('tous les topics autorisés → true', () => {
    expect(areTopicsAllowed(['orders:42:status', 'orders:99:events'], ['orders:*'])).toBe(true)
  })

  it('un topic non autorisé → false', () => {
    expect(areTopicsAllowed(['orders:42:status', 'users:1'], ['orders:*'])).toBe(false)
  })
})
