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
    string: { Icon: Type, tile: 'bg-sky-500/12 border-sky-500/25 text-sky-400', label: 'Text' },
    number: { Icon: Hash, tile: 'bg-violet-500/12 border-violet-500/25 text-violet-400', label: 'Number' },
    boolean: { Icon: ToggleLeft, tile: 'bg-emerald-500/12 border-emerald-500/25 text-emerald-400', label: 'Boolean' },
}

const UNKNOWN_META: TypeMeta = { Icon: Braces, tile: 'bg-glass/40 border-glass-border/60 text-ink-muted', label: 'Property' }

export function typeMeta(t: ValueType): TypeMeta {
    return t ? TYPE_META[t] : UNKNOWN_META
}
