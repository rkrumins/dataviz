import { useCanvasStore } from '@/store/canvas'
import type { NameLookup } from '@/features/versioning/model/reviewModel'

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
