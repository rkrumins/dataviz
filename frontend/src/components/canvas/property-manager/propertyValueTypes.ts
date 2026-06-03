/**
 * propertyValueTypes — pure (non-component) helpers for inferring a
 * property's value type and mapping it to an icon + tone. Kept separate
 * from PropertyValueChips.tsx so that file only exports components.
 */
import { Braces, Hash, ToggleLeft, Type, type LucideIcon } from 'lucide-react'


export type ValueType = 'string' | 'number' | 'boolean' | null

/** Infer a value type from discovered sample values (first non-null). */
export function inferType(samples: unknown[]): ValueType {
    const v = samples.find((s) => s !== null && s !== undefined)
    if (typeof v === 'number') return 'number'
    if (typeof v === 'boolean') return 'boolean'
    if (typeof v === 'string') return 'string'
    return null
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
