import { useCanvasStore } from '@/store/canvas'
import type { NameLookup } from '@/features/versioning/model/reviewModel'
import type { Placement } from '@/features/versioning/model/reviewTree'

/** Names for ids and urns, as the canvas holds them — read once per use, never subscribed to. */
export function canvasLookup(): NameLookup {
  let names: Map<string, { label: string; type?: string }> | null = null
  const index = () => {
    if (names) return names
    names = new Map()
    for (const n of useCanvasStore.getState().nodes) {
      const d = n.data as Record<string, unknown>
      const entry = { label: String(d.label ?? d.displayName ?? n.id), type: typeof d.type === 'string' ? d.type : undefined }
      names.set(n.id, entry)
      if (typeof d.urn === 'string') names.set(d.urn, entry)
    }
    return names
  }
  return {
    nameOf: (id: string) => index().get(id)?.label ?? id,
    typeOf: (id: string) => index().get(id)?.type,
  }
}

/** Where the canvas places each entity it holds — under its parent, or under the containers its feed
 *  named (`ancestorPath`, root first) — by urn. Read once per use, never subscribed to. */
export function canvasPlacement(): Placement {
  type Index = { parent: Map<string, string | null>; key: Map<string, string>; name: Map<string, string>; type: Map<string, string | undefined> }
  let built: Index | null = null
  const index = (): Index => {
    if (built) return built
    const parent = new Map<string, string | null>()
    const key = new Map<string, string>()
    const name = new Map<string, string>()
    const type = new Map<string, string | undefined>()
    const nodes = useCanvasStore.getState().nodes
    for (const n of nodes) {
      const urn = typeof n.data.urn === 'string' && n.data.urn ? n.data.urn : n.id
      key.set(n.id, urn)
      key.set(urn, urn)
    }
    for (const n of nodes) {
      const d = n.data
      const urn = key.get(n.id)!
      name.set(urn, String(d.label ?? n.id))
      type.set(urn, typeof d.type === 'string' ? d.type : undefined)
      const path = d.ancestorPath ?? []
      const up = d.parentId ? (key.get(d.parentId) ?? d.parentId) : path.length ? path[path.length - 1].urn : null
      if (parent.get(urn) == null) parent.set(urn, up)
      path.forEach((a, i) => {
        if (!parent.has(a.urn)) parent.set(a.urn, i ? path[i - 1].urn : null)
        if (!name.has(a.urn)) { name.set(a.urn, a.displayName); type.set(a.urn, a.entityType) }
      })
    }
    return (built = { parent, key, name, type })
  }
  return {
    parentOf: (id) => index().parent.get(index().key.get(id) ?? id),
    keyOf: (id) => index().key.get(id) ?? id,
    nameOf: (id) => index().name.get(index().key.get(id) ?? id) ?? id,
    typeOf: (id) => index().type.get(index().key.get(id) ?? id),
  }
}
