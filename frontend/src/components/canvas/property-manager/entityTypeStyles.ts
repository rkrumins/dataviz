/**
 * entityTypeStyles — colour/identity for entity types in the Property
 * Manager (used-by chips + per-type usage bars). Mirrors the
 * AggregateBucketCard ENTITY_STYLES idea (the codebase keeps a few local
 * copies of this map); a small focused copy here keeps the property cards
 * colourful and on-brand without a cross-module refactor.
 */
export interface EntityTypeStyle {
    /** Static chip classes (bg + text + border) — light/dark aware. */
    chip: string
    /** Tailwind gradient classes for a per-type bar fill. */
    bar: string
    /** Ring/dot hex colour. */
    ring: string
}

type Family = 'emerald' | 'sky' | 'violet' | 'purple' | 'amber' | 'rose' | 'cyan' | 'indigo' | 'slate'

const FAMILIES: Record<Family, EntityTypeStyle> = {
    emerald: { chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20', bar: 'from-emerald-500/70 to-teal-500', ring: '#10b981' },
    sky: { chip: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20', bar: 'from-sky-500/70 to-blue-500', ring: '#0ea5e9' },
    violet: { chip: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20', bar: 'from-violet-500/70 to-fuchsia-500', ring: '#8b5cf6' },
    purple: { chip: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/20', bar: 'from-purple-500/70 to-violet-500', ring: '#a855f7' },
    amber: { chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20', bar: 'from-amber-500/70 to-orange-500', ring: '#f59e0b' },
    rose: { chip: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/20', bar: 'from-rose-500/70 to-pink-500', ring: '#f43f5e' },
    cyan: { chip: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border-cyan-500/20', bar: 'from-cyan-500/70 to-sky-500', ring: '#06b6d4' },
    indigo: { chip: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/20', bar: 'from-indigo-500/70 to-blue-500', ring: '#6366f1' },
    slate: { chip: 'bg-slate-500/10 text-ink-secondary border-glass-border/60', bar: 'from-slate-400/60 to-slate-500', ring: '#94a3b8' },
}

/** Curated assignments for the common entity types. */
const TYPE_FAMILY: Record<string, Family> = {
    dataset: 'emerald', table: 'emerald', view: 'emerald',
    schemaField: 'sky', attribute: 'sky', column: 'sky', field: 'sky',
    container: 'purple', folder: 'purple',
    schema: 'violet', group: 'violet',
    domain: 'amber', glossaryTerm: 'amber', businessTerm: 'amber',
    dataPlatform: 'cyan', system: 'cyan', dataSource: 'cyan',
    pipeline: 'rose', dashboard: 'rose', report: 'rose',
    dataFlow: 'indigo', tag: 'indigo',
}

const ROTATION: Family[] = ['emerald', 'sky', 'violet', 'purple', 'amber', 'rose', 'cyan', 'indigo']

/** Deterministic colour for any entity type — curated where known, else a
 *  stable hash into the rotation so arbitrary types still read colourful. */
export function entityTypeStyle(type: string): EntityTypeStyle {
    const known = TYPE_FAMILY[type]
    if (known) return FAMILIES[known]
    if (!type) return FAMILIES.slate
    let h = 0
    for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0
    return FAMILIES[ROTATION[h % ROTATION.length]]
}
