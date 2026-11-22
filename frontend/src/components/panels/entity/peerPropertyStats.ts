/** What other loaded entities of a type carry — the names offered as a property is added. */
import { useCanvasStore } from '@/store/canvas'
import { userProperties } from '@/lib/nodeFields'
import { inferFieldType, type FieldType } from '../property/fieldTypes'
import type { PropertySuggestion } from '../property/composerModel'

type Data = Record<string, unknown>

/** Entities read before the suggestions give up: enough to see what a type usually carries. */
const SUGGEST_SCAN = 2000

/** What other loaded entities of this type carry, property by property — how many, a couple of
 *  example values, and the type its values usually are — for those at least two carry, most common
 *  first. Read once from the canvas as it is when the drawer opens on the entity, never subscribed to. */
export function peerPropertyStats(nodeId: string, typeId: string): PropertySuggestion[] {
  if (!typeId) return []
  const stats = new Map<string, { count: number; examples: string[]; types: Map<FieldType, number> }>()
  let scanned = 0
  for (const n of useCanvasStore.getState().nodes) {
    const d = n.data as Data
    if (n.id === nodeId || d.type !== typeId) continue
    if (++scanned > SUGGEST_SCAN) break
    for (const [k, v] of Object.entries(userProperties(d.properties))) {
      let st = stats.get(k)
      if (!st) stats.set(k, (st = { count: 0, examples: [], types: new Map() }))
      st.count++
      const t = inferFieldType(v)
      st.types.set(t, (st.types.get(t) ?? 0) + 1)
      const ex = typeof v === 'string' || typeof v === 'number' ? String(v) : null
      if (ex && ex.length <= 40 && st.examples.length < 2 && !st.examples.includes(ex)) st.examples.push(ex)
    }
  }
  return [...stats].filter(([, st]) => st.count >= 2).sort((a, b) => b[1].count - a[1].count).slice(0, 24)
    .map(([key, st]) => ({ key, count: st.count, examples: st.examples, type: [...st.types].sort((a, b) => b[1] - a[1])[0]?.[0] }))
}
