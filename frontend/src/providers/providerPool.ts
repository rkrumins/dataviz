/**
 * Shared provider pool — LRU cache of RemoteGraphProvider instances keyed by
 * workspace + data source. Used by both ViewExecutionProvider (canvas views)
 * and SchemaScope (wizard, admin) so the same scope reuses the same provider
 * and its response cache / circuit breaker.
 */

import { RemoteGraphProvider } from './RemoteGraphProvider'

interface PoolEntry {
  provider: RemoteGraphProvider
  lastUsed: number
}

const providerPool = new Map<string, PoolEntry>()
const POOL_MAX_SIZE = 8

export function poolKey(wsId: string, dsId: string | null, branchId?: string | null): string {
  // A draft is a distinct read-context from main — keying on branchId gives it its
  // own provider instance (and response cache), so switching branches can't serve
  // stale cross-branch data.
  return `${wsId}:${dsId ?? 'default'}:${branchId ?? 'main'}`
}

export function getOrCreateProvider(
  wsId: string,
  dsId: string | null,
  branchId?: string | null,
): RemoteGraphProvider {
  const key = poolKey(wsId, dsId, branchId)
  const existing = providerPool.get(key)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing.provider
  }
  // Evict LRU if pool is full
  if (providerPool.size >= POOL_MAX_SIZE) {
    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [k, v] of providerPool) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed
        oldestKey = k
      }
    }
    if (oldestKey) providerPool.delete(oldestKey)
  }
  const provider = new RemoteGraphProvider({
    workspaceId: wsId,
    dataSourceId: dsId ?? undefined,
    branchId: branchId ?? undefined,
  })
  providerPool.set(key, { provider, lastUsed: Date.now() })
  return provider
}
