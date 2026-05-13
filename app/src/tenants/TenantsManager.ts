import { prisma as defaultPrisma } from '../db/prisma.js'
import type { PrismaClient, Tenant } from '@prisma/client'

/**
 * Cache en mémoire des tenants chargés depuis la base de données.
 *
 * Le cache est peuplé une première fois au démarrage via `load()`, puis
 * rafraîchi toutes les 60 secondes et sur signal `SIGHUP` via `reload()`.
 * Les lookups JWT (`getTenant`) sont donc O(1) sans aller en base.
 */
export class TenantsManager {
  private cache = new Map<string, Tenant>()

  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /**
   * Charge (ou recharge) tous les tenants depuis la base et remplace le cache.
   * Lève une exception si la base est inaccessible.
   */
  async load(): Promise<void> {
    const tenants = await this.db.tenant.findMany()
    this.cache.clear()
    for (const tenant of tenants) {
      this.cache.set(tenant.appId, tenant)
    }
  }

  /** Retourne le tenant par `appId`, ou `null` s'il est inconnu. */
  getTenant(appId: string): Tenant | null {
    return this.cache.get(appId) ?? null
  }

  getAllTenants(): Tenant[] {
    return Array.from(this.cache.values())
  }

  /** Alias de `load()` — utilisé pour les rechargements périodiques et SIGHUP. */
  async reload(): Promise<void> {
    await this.load()
  }
}

