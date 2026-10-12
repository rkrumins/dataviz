/**
 * propertyValueTypes — pure (non-component) helpers for a property's value
 * type and its icon + tone. Kept separate from PropertyValueChips.tsx so
 * that file only exports components.
 */
import { Braces, Hash, List, ToggleLeft, Type, type LucideIcon } from 'lucide-react'


export type ValueType = 'string' | 'number' | 'boolean' | 'list' | null

/** Each kind the graph stores a value as (``typeOf``), as a type. Integers
 *  and decimals are both numbers: they compare as one. */
const KIND_TYPE: Record<string, NonNullable<ValueType>> = {
    Integer: 'number', Float: 'number', String: 'string', Boolean: 'boolean', List: 'list',
}

/** How each stored kind reads to a person. */
export const KIND_LABEL: Record<string, string> = {
    Integer: 'Integer', Float: 'Decimal', String: 'Text', Boolean: 'Boolean', List: 'List',
}

/**
 * The type most of a key's entities store it as, and whether they disagree
 * — from the catalog's exact count of entities per stored kind. A key held
 * as a boolean by some entities and as the text "true" by others is mixed:
 * a typed search compares each kind as its own.
 */
export function storedType(kinds: Readonly<Record<string, number>>): { type: ValueType; mixed: boolean } {
    const byType = new Map<NonNullable<ValueType>, number>()
    for (const [kind, n] of Object.entries(kinds)) {
        const t = KIND_TYPE[kind]
        if (t) byType.set(t, (byType.get(t) ?? 0) + n)
    }
    let type: ValueType = null
    let most = 0
    for (const [t, n] of byType) {
        if (n > most) { type = t; most = n }
    }
    return { type, mixed: byType.size > 1 }
}

export interface TypeMeta { Icon: LucideIcon; tile: string; label: string }

const TYPE_META: Record<NonNullable<ValueType>, TypeMeta> = {
    string: { Icon: Type, tile: 'bg-gradient-to-br from-sky-500/25 to-blue-500/15 border-sky-500/20 text-sky-500 dark:text-sky-400', label: 'Text' },
    number: { Icon: Hash, tile: 'bg-gradient-to-br from-violet-500/25 to-fuchsia-500/15 border-violet-500/20 text-violet-500 dark:text-violet-400', label: 'Number' },
    boolean: { Icon: ToggleLeft, tile: 'bg-gradient-to-br from-emerald-500/25 to-teal-500/15 border-emerald-500/20 text-emerald-500 dark:text-emerald-400', label: 'Boolean' },
    list: { Icon: List, tile: 'bg-gradient-to-br from-amber-500/25 to-orange-500/15 border-amber-500/20 text-amber-500 dark:text-amber-400', label: 'List' },
}

const UNKNOWN_META: TypeMeta = { Icon: Braces, tile: 'bg-gradient-to-br from-accent-lineage/20 to-purple-500/15 border-glass-border/60 text-ink-muted', label: 'Property' }

export function typeMeta(t: ValueType): TypeMeta {
    return t ? TYPE_META[t] : UNKNOWN_META
}
