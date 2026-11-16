/**
 * The two lenses on the same settings.
 *
 * - BUSINESS asks each setting's question in plain words, with outcome cards, and leads with the
 *   settings a workspace admin or a data owner decides.
 * - OPERATOR shows the full detail: env var, when a change takes effect, caps and evidence, in
 *   category order.
 *
 * Both show every setting the viewer may change; the lens only orders and frames them. It opens on
 * the app's own business/technical view (the persona switch), and changing it here changes only
 * this page.
 */
import { useState } from 'react'
import { usePersonaStore, type PersonaMode } from '@/store/persona'
import type { Category, Setting } from './types'

export type Lens = 'business' | 'operator'

export const lensFor = (persona: PersonaMode): Lens => (persona === 'technical' ? 'operator' : 'business')

/** The lens, opening on the persona's. */
export function useLens(): [Lens, (lens: Lens) => void] {
    const persona = usePersonaStore((s) => s.mode)
    const [lens, setLens] = useState<Lens>(() => lensFor(persona))
    return [lens, setLens]
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
