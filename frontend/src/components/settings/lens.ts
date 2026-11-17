/**
 * The settings in the app's own Business or Technical view: one switch, the app's.
 *
 * - BUSINESS asks each setting's question in plain words, with outcome cards, and leads with the
 *   settings a workspace admin or a data owner decides.
 * - TECHNICAL (the `operator` lens here) shows the full detail: env var, when a change takes
 *   effect, caps, evidence and ids, in category order.
 *
 * Both show every setting the viewer may change; the view only orders and frames them. The lens
 * is the persona (`store/persona.ts`), nothing of its own: the top bar's switch, ⌘/ and the
 * settings' own `LensSwitch` all change it, and every settings surface follows at once.
 */
import { usePersonaMode, usePersonaStore, type PersonaMode } from '@/store/persona'
import type { Category, Setting } from './types'

export type Lens = 'business' | 'operator'

export const lensFor = (persona: PersonaMode): Lens => (persona === 'technical' ? 'operator' : 'business')

const setLens = (l: Lens) => usePersonaStore.getState().setMode(l === 'operator' ? 'technical' : 'business')

/** The app's view as a lens, and a setter that changes the app's view. */
export function useLens(): [Lens, (lens: Lens) => void] {
    return [lensFor(usePersonaMode()), setLens]
}

/** Every setting, ordered for the lens: business first under Business, category order under Operator. */
export function orderForLens(settings: Setting[], lens: Lens, categories: Category[]): Setting[] {
    const catOrder = new Map(categories.map((c) => [c.id, c.order]))
    const sectionOrder = (s: Setting) =>
        categories.find((x) => x.id === s.category)?.sections.findIndex((x) => x.id === s.section) ?? -1
    return settings
        .map((s, i) => ({ s, i }))
        .sort((a, b) => {
            if (lens === 'business') {
                const aud = Number(a.s.audience !== 'business') - Number(b.s.audience !== 'business')
                if (aud) return aud
            }
            const cat = (catOrder.get(a.s.category) ?? 99) - (catOrder.get(b.s.category) ?? 99)
            if (cat) return cat
            if (lens === 'operator') {
                const sec = sectionOrder(a.s) - sectionOrder(b.s)
                if (sec) return sec
            }
            return a.i - b.i
        })
        .map(({ s }) => s)
}
