/**
 * Teste si un `topic` correspond à un `pattern` JWT.
 *
 * Règles de matching (segments séparés par `:`) :
 * - Égalité exacte : `orders:42` correspond à `orders:42`
 * - Wildcard terminal `*` : `orders:*` correspond à `orders:42`, `orders:42:status`, etc.
 * - Wildcard interne `*` : `orders:*:status` correspond uniquement à `orders:42:status`
 *   (le segment wildcard remplace exactement un segment).
 *
 * @example
 * matchesTopic('orders:*', 'orders:42:status') // true  (wildcard terminal)
 * matchesTopic('orders:*:status', 'orders:42') // false (longueurs différentes)
 */
export function matchesTopic(pattern: string, topic: string): boolean {
  if (pattern === topic) return true

  const patternParts = pattern.split(':')
  const topicParts = topic.split(':')

  const hasTrailingWildcard = patternParts[patternParts.length - 1] === '*'

  if (hasTrailingWildcard) {
    const prefix = patternParts.slice(0, -1)
    if (topicParts.length < prefix.length) return false
    return prefix.every((part, i) => part === topicParts[i])
  }

  if (patternParts.length !== topicParts.length) return false
  return patternParts.every((part, i) => part === '*' || part === topicParts[i])
}

/** Vérifie qu'un topic est couvert par au moins un pattern de la liste `allowed`. */
export function isTopicAllowed(requested: string, allowed: string[]): boolean {
  return allowed.some(pattern => matchesTopic(pattern, requested))
}

/** Vérifie que tous les topics demandés sont couverts par la liste `allowed`. */
export function areTopicsAllowed(requested: string[], allowed: string[]): boolean {
  return requested.every(topic => isTopicAllowed(topic, allowed))
}
