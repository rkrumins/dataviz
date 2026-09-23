/**
 * propertyValueTypes — pure (non-component) helpers for inferring a
 * property's value type and mapping it to an icon + tone. Kept separate
 * from PropertyValueChips.tsx so that file only exports components.
 */
import { Braces, Hash, ToggleLeft, Type, type LucideIcon } from 'lucide-react'


export type ValueType = 'string' | 'number' | 'boolean' | null

function kindOf(v: unknown): ValueType {
    if (typeof v === 'number') return 'number'
    if (typeof v === 'boolean') return 'boolean'
    // An integer too long for a double arrives as its exact digits (see
    // lib/losslessJson) — it is still a number.
    if (typeof v === 'string') return /^-?[1-9]\d{15,}$/.test(v) ? 'number' : 'string'
    return null
}

/** Infer a value type from discovered sample values — the kind MOST of them
 *  have. The first sample alone decided before, so one stray value typed the
 *  whole property. */
export function inferType(samples: unknown[]): ValueType {
    const counts = new Map<NonNullable<ValueType>, number>()
    for (const s of samples) {
        const k = kindOf(s)
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    let best: ValueType = null
    let most = 0
    for (const [k, n] of counts) {
        if (n > most) { best = k; most = n }
    }
    return best
}

export interface TypeMeta { Icon: LucideIcon; tile: string; label: string }

const TYPE_META: Record<NonNullable<ValueType>, TypeMeta> = {
    string: { Icon: Type, tile: 'bg-gradient-to-br from-sky-500/25 to-blue-500/15 border-sky-500/20 text-sky-500 dark:text-sky-400', label: 'Text' },
    number: { Icon: Hash, tile: 'bg-gradient-to-br from-violet-500/25 to-fuchsia-500/15 border-violet-500/20 text-violet-500 dark:text-violet-400', label: 'Number' },
    boolean: { Icon: ToggleLeft, tile: 'bg-gradient-to-br from-emerald-500/25 to-teal-500/15 border-emerald-500/20 text-emerald-500 dark:text-emerald-400', label: 'Boolean' },
}

const UNKNOWN_META: TypeMeta = { Icon: Braces, tile: 'bg-gradient-to-br from-accent-lineage/20 to-purple-500/15 border-glass-border/60 text-ink-muted', label: 'Property' }

export function typeMeta(t: ValueType): TypeMeta {
    return t ? TYPE_META[t] : UNKNOWN_META
}
