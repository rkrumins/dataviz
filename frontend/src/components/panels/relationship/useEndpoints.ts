/**
 * The entities at either end of a relationship: their names, and a way to open
 * one in the drawer.
 */
import { useCallback, useMemo, useState } from 'react'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { resolveEntityName } from '@/lib/entityDisplayName'
import { withTimeout, TimeoutError } from '@/lib/concurrency'
import { TIMEOUTS } from '@/config/timeouts'

export interface Endpoint {
  id: string
  name: string
  type?: string
  /** Known to the canvas (or to the surface drawing it) — not just an id. */
  known: boolean
}

/** Names for `ids`, from the canvas store or the surface drawing them (a trace).
 *  Pass a memoised `ids` array. */
export function useEndpoints(ids: readonly string[], resolveNode?: (id: string) => LineageNode | null): Map<string, Endpoint> {
  const nodes = useCanvasStore((s) => s.nodes)
  const mode = usePersonaStore((s) => s.mode)
  return useMemo(() => {
    const wanted = new Set(ids)
    const found = new Map<string, LineageNode>()
    for (const n of nodes) if (wanted.has(n.id)) found.set(n.id, n)
    const out = new Map<string, Endpoint>()
    for (const id of wanted) {
      const node = found.get(id) ?? resolveNode?.(id) ?? undefined
      out.set(id, {
        id,
        name: node ? resolveEntityName(node.data, mode, id) : id,
        type: node?.data.type as string | undefined,
        known: !!node,
      })
    }
    return out
  }, [nodes, mode, ids, resolveNode])
}

/**
 * Open an endpoint in the drawer. One the canvas already holds swaps in at
 * once; one it has not loaded (the real end of a rolled-up relationship, deep
 * inside a collapsed container) is revealed FIRST — opening the drawer on an id
 * the store cannot answer for would leave the rail empty. Mirrors the lineage
 * list's neighbour rows.
 */
export function useOpenEndpoint(
  onFocusNode?: (nodeId: string) => void | Promise<unknown>,
  resolveNode?: (id: string) => LineageNode | null,
) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [unreachableId, setUnreachableId] = useState<string | null>(null)

  const open = useCallback(async (id: string) => {
    setUnreachableId(null)
    const s = useCanvasStore.getState()
    const show = () => {
      const st = useCanvasStore.getState()
      st.openNodeDrawer(id)
      st.selectNode(id)
    }
    if (s._nodeIndex.has(id) || resolveNode?.(id)) {
      show()
      void onFocusNode?.(id)
      return
    }
    if (!onFocusNode) { setUnreachableId(id); return }
    setPendingId(id)
    try {
      const result = onFocusNode(id)
      const outcome = result && typeof (result as Promise<unknown>).then === 'function'
        ? await withTimeout(result as Promise<unknown>, TIMEOUTS.LINEAGE_FOCUS_MS, 'relationship.openEndpoint')
        : undefined
      if (outcome === 'unavailable' || !useCanvasStore.getState()._nodeIndex.has(id)) setUnreachableId(id)
      else show()
    } catch (err) {
      if (!(err instanceof TimeoutError)) throw err
      setUnreachableId(id)
    } finally {
      setPendingId(null)
    }
  }, [onFocusNode, resolveNode])

  return { open, pendingId, unreachableId }
}
