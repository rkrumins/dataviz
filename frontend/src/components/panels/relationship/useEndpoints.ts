/**
 * The entities at either end of a relationship: their names and types, and a
 * way to open one in the drawer.
 */
import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { nodeIndexOf } from '@/lib/storeIndex'
import { usePersonaStore } from '@/store/persona'
import { resolveEntityName } from '@/lib/entityDisplayName'
import { toCanvasNode } from '@/lib/canvasNodeMapper'
import { formatUrnLabel } from '@/lib/urnLabels'
import { useResolvedEntities } from '@/hooks/useResolvedNames'
import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import { withTimeout, TimeoutError } from '@/lib/concurrency'
import { TIMEOUTS } from '@/config/timeouts'

export interface Endpoint {
  id: string
  name: string
  /** The entity type's id. */
  type?: string
  /** Named — by the canvas, the surface drawing it (a trace) or the data source — not just an id. */
  known: boolean
}

/** Names and types for `ids`: from the canvas store, else the surface drawing them (a trace), else
 *  the data source — one batched lookup for the ends the canvas has not loaded (the real ends of a
 *  lifted or rolled-up relationship, deep inside collapsed cards). Until it answers, an end reads
 *  as the tail of its id. Pass a memoised `ids` array. Re-renders only when one of THESE nodes
 *  changes, or the lookup answers. */
export function useEndpoints(ids: readonly string[], resolveNode?: (id: string) => LineageNode | null): Map<string, Endpoint> {
  const found = useCanvasStore(useShallow((s) => {
    const index = nodeIndexOf(s.nodes)
    return ids.map((id) => index.get(id))
  }))
  const mode = usePersonaStore((s) => s.mode)
  const local = useMemo(
    () => ids.map((id, i) => found[i] ?? resolveNode?.(id) ?? undefined), [found, ids, resolveNode])
  const unknown = useMemo(() => ids.filter((_, i) => !local[i]), [ids, local])
  const fetched = useResolvedEntities(unknown, useGraphProviderIfAvailable())
  return useMemo(() => {
    const out = new Map<string, Endpoint>()
    ids.forEach((id, i) => {
      if (out.has(id)) return
      const remote = fetched.get(id)
      const node = local[i] ?? (remote ? toCanvasNode(remote) : undefined)
      out.set(id, {
        id,
        name: node ? resolveEntityName(node.data, mode, id) : formatUrnLabel(id, 48),
        type: node?.data.type as string | undefined,
        known: !!node,
      })
    })
    return out
  }, [local, fetched, mode, ids])
}

/**
 * Open an endpoint in the drawer. One the canvas already holds swaps in at
 * once; one it has not loaded (the real end of a rolled-up relationship, deep
 * inside a collapsed container) is revealed FIRST — opening the drawer on an id
 * the store cannot answer for would leave the rail empty. Mirrors the lineage
 * list's neighbour rows.
 *
 * The whole of it is one drawer move: with unsaved edits in the drawer nothing
 * happens — no reveal, no swap — until the reader decides.
 */
export function useOpenEndpoint(
  onFocusNode?: (nodeId: string) => void | Promise<unknown>,
  resolveNode?: (id: string) => LineageNode | null,
) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [unreachableId, setUnreachableId] = useState<string | null>(null)

  const run = useCallback(async (id: string) => {
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

  const open = useCallback((id: string) => {
    useCanvasStore.getState().requestDrawerMove(() => { void run(id) })
  }, [run])

  return { open, pendingId, unreachableId }
}
