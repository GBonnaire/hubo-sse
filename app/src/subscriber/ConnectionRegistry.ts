/**
 * Registre des fonctions de nettoyage indexées par connectionId.
 * Permet à un endpoint HTTP de fermer une connexion SSE active.
 */
export class ConnectionRegistry {
  private cleanups = new Map<string, () => void>()

  register(id: string, cleanup: () => void): void {
    this.cleanups.set(id, cleanup)
  }

  /**
   * Exécute et supprime le cleanup pour un id donné.
   * Idempotent : un second appel pour le même id est un no-op.
   */
  invoke(id: string): boolean {
    const cleanup = this.cleanups.get(id)
    if (!cleanup) return false
    this.cleanups.delete(id)
    cleanup()
    return true
  }
}
