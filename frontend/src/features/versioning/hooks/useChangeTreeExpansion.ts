/**
 * Lazy expansion state for the hierarchical change tree. Each container/bucket loads its
 * direct children on first open (paged) via the supplied `fetchChildren` — so a draft that
 * touches thousands of entities never ships them all at once. Mirrors the bounded,
 * cancel-on-collapse model of `useGraphHydration`, minus the canvas store: a stale response
 * for a collapsed-then-reopened node is dropped via a per-key request token.
 */
import { useCallback, useRef, useState } from 'react'
import type { DiffChildrenResponse, DiffTreeNode } from '@/services/versioningApiService'

export type FetchChildren = (key: string, offset: number) => Promise<DiffChildrenResponse>

interface NodeChildren {
  entries: DiffTreeNode[]
  total: number
  loaded: number
}

const withKey = (s: Set<string>, key: string, on: boolean): Set<string> => {
  const n = new Set(s)
  if (on) n.add(key)
  else n.delete(key)
  return n
}

export function useChangeTreeExpansion(fetchChildren: FetchChildren, pageSize = 50) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [byKey, setByKey] = useState<Record<string, NodeChildren>>({})
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<Set<string>>(new Set())
  const reqId = useRef<Record<string, number>>({})

  const load = useCallback(
    async (key: string, offset: number) => {
      const mine = (reqId.current[key] = (reqId.current[key] ?? 0) + 1)
      setLoading((s) => withKey(s, key, true))
      setFailed((s) => withKey(s, key, false))
      try {
        const res = await fetchChildren(key, offset)
        if (reqId.current[key] !== mine) return // superseded by a newer open
        setByKey((prev) => {
          const base = offset > 0 ? prev[key]?.entries ?? [] : []
          return {
            ...prev,
            [key]: { entries: [...base, ...res.entries], total: res.total, loaded: offset + res.entries.length },
          }
        })
      } catch {
        if (reqId.current[key] === mine) setFailed((s) => withKey(s, key, true))
      } finally {
        if (reqId.current[key] === mine) setLoading((s) => withKey(s, key, false))
      }
    },
    [fetchChildren],
  )

  const toggle = useCallback(
    (key: string) => {
      setExpanded((prev) => {
        const next = withKey(prev, key, !prev.has(key))
        if (!prev.has(key) && !byKey[key]) void load(key, 0)
        return next
      })
    },
    [byKey, load],
  )

  const loadMore = useCallback(
    (key: string) => {
      const st = byKey[key]
      if (st && st.loaded < st.total) void load(key, st.loaded)
    },
    [byKey, load],
  )

  const retry = useCallback((key: string) => void load(key, 0), [load])

  return { expanded, byKey, loading, failed, toggle, loadMore, retry, pageSize }
}

export type ChangeTreeExpansion = ReturnType<typeof useChangeTreeExpansion>
