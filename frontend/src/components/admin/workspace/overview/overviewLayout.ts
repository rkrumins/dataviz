/**
 * How the Overview lays its views out — compact tiles, the Explorer's cards or its
 * list — remembered for the reader on this browser. A convenience: when storage
 * can't be read, the Overview opens on cards.
 */
import { useState } from 'react'

export type OverviewLayout = 'compact' | 'cards' | 'list'

const KEY = 'nx-overview-layout'
const LAYOUTS: readonly OverviewLayout[] = ['compact', 'cards', 'list']

function read(): OverviewLayout {
    try {
        const v = window.localStorage.getItem(KEY)
        return LAYOUTS.includes(v as OverviewLayout) ? (v as OverviewLayout) : 'cards'
    } catch {
        return 'cards'
    }
}

export function useOverviewLayout(): [OverviewLayout, (layout: OverviewLayout) => void] {
    const [layout, setLayout] = useState<OverviewLayout>(read)
    const choose = (next: OverviewLayout) => {
        setLayout(next)
        try { window.localStorage.setItem(KEY, next) } catch { /* kept for this visit only */ }
    }
    return [layout, choose]
}
