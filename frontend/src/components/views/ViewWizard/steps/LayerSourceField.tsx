/**
 * LayerSourceField — the Layout step's answer to "what fills this layer?", in the layer editor:
 * one segmented control (By type · Hand-picked · Mapped to an entity), what the chosen source
 * means for the column on the canvas, and what choosing it needs — the types, or the entity.
 *
 * A switch that drops something (its types, its mapping) is made at once and says what it
 * dropped, with an Undo — as the canvas's own column gestures do. Mapping waits for an entity to
 * be picked, and says before then what it will drop and why. The kinds and their wording are the
 * canvas's (`columnKind`); what each switch writes is `layerSource`.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Link2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { caseFold } from '@/features/ontology/lib/caseFold'
import type { EntityTypeSchema, ViewLayerConfig } from '@/types/schema'
import type { PersonaMode } from '@/store/persona'
import { COLUMN_KIND_ICON, columnKindCopy } from '@/components/canvas/context-view/columnKind'
import { EntitySearchPicker, type PickerOption } from '@/components/panels/entity/EntitySearchPicker'
import type { TopLevelEntity } from '../autoLayers'
import { ENTITY_COLUMNS_MAX } from '../useTopLevelEntities'
import {
    layerSourceOf, toByType, toEntity, toHandPicked, type LayerFillState, type LayerSource,
} from '../layerSource'

const SOURCES: Array<{ id: LayerSource; label: string }> = [
    { id: 'byType', label: 'By type' },
    { id: 'handPicked', label: 'Hand-picked' },
    { id: 'mapped', label: 'Mapped to an entity' },
]

/** "Domains", "Domains and Teams", "Apps, Services and Jobs" — joined with `word`. */
function listOf(names: readonly string[], word: 'and' | 'or'): string {
    return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} ${word} ${names[names.length - 1]}`
}

const typeOf = (typesByFold: Map<string, EntityTypeSchema>, id: string) => typesByFold.get(caseFold(id))

/** What fills the layer now, for "No longer fills with …": its types, or what its rules pick. */
function fillsWith(layer: ViewLayerConfig, typesByFold: Map<string, EntityTypeSchema>): string | null {
    const types = (layer.entityTypes ?? []).map(t => { const et = typeOf(typesByFold, t); return et ? (et.pluralName || et.name) : t })
    const rules = (layer.rules ?? []).length > 0
    if (types.length === 0) return rules ? 'what its rules pick out' : null
    return `${listOf(types, 'and')}${rules ? ', or what its rules pick out' : ''}`
}

/** Why a mapped column takes no types. */
function pullReason(layer: ViewLayerConfig, typesByFold: Map<string, EntityTypeSchema>): string {
    const types = (layer.entityTypes ?? []).map(t => typeOf(typesByFold, t)?.name ?? t)
    return types.length > 0
        ? `a type rule would pull every ${listOf(types, 'or')} into the column`
        : 'its rules would pull what they pick out into the column'
}

const unmappedNotice = (name: string) => `${name} shows as a row now — the column is no longer mapped to it.`

export function LayerSourceField({
    layer, fill, onChange, entityTypes, typesByFold, entities, entitiesLoading, entitiesCapped, nameOf, persona, placedWhere,
}: {
    layer: ViewLayerConfig
    fill: LayerFillState
    onChange: (next: LayerFillState) => void
    /** The types a layer can be filled with. */
    entityTypes: EntityTypeSchema[]
    typesByFold: Map<string, EntityTypeSchema>
    /** The top-level entities a layer can be mapped to. */
    entities: readonly TopLevelEntity[]
    entitiesLoading: boolean
    /** Some type has more than are listed. */
    entitiesCapped: boolean
    /** An entity's name, as the reader sees it. */
    nameOf: (urn: string) => string
    persona: PersonaMode
    /** Where a hand-picked layer's entities are placed. */
    placedWhere: string
}) {
    const [picking, setPicking] = useState(false)
    // "By type" chosen for a layer nothing fills yet: its types come next.
    const [byTypeChosen, setByTypeChosen] = useState(false)
    // What the last switch dropped: undone while nothing else has changed since.
    const [notice, setNotice] = useState<{ text: string; before: LayerFillState; after: LayerFillState } | null>(null)
    const undoable = !!notice && notice.after.layers === fill.layers && notice.after.assignments === fill.assignments

    const current = layerSourceOf(layer)
    const shown: LayerSource = picking ? 'mapped' : byTypeChosen && current === 'handPicked' ? 'byType' : current
    const anchorName = layer.anchorUrn ? nameOf(layer.anchorUrn) : null
    const what = fillsWith(layer, typesByFold)
    const typeName = (id: string) => typeOf(typesByFold, id)?.name ?? id

    const commit = (next: LayerFillState, text: string | null) => {
        setNotice(text ? { text, before: fill, after: next } : null)
        onChange(next)
    }

    const choose = (to: LayerSource) => {
        if (to === shown) return
        setPicking(false)
        setByTypeChosen(false)
        if (to === 'mapped') {
            setNotice(null)
            setPicking(true)
            return
        }
        if (to === 'byType') {
            setByTypeChosen(true)
            if (anchorName) commit(toByType(fill, layer.id, anchorName), unmappedNotice(anchorName))
            return
        }
        if (current === 'handPicked') return
        commit(toHandPicked(fill, layer.id, anchorName ?? undefined),
            anchorName ? unmappedNotice(anchorName) : `No longer fills with ${what} — it holds only what’s placed in it.`)
    }

    const pick = (urn: string) => {
        const name = nameOf(urn)
        const next = toEntity(fill, layer.id, urn, name)
        const was = layer.anchorUrn && layer.anchorUrn !== urn && next.assignments[layer.anchorUrn]?.layerId === layer.id
            ? nameOf(layer.anchorUrn) : null
        setPicking(false)
        commit(next, what
            ? `Mapped to ${name}. No longer fills with ${what}: ${pullReason(layer, typesByFold)}.`
            : `Mapped to ${name} — its rows are what’s inside ${name}.${was ? ` ${was} stays in it as a row.` : ''}`)
    }

    const undo = () => {
        if (!notice || !undoable) return
        setByTypeChosen(false)
        setNotice(null)
        onChange(notice.before)
    }

    // The picker's choices: the column's own placements first, then by name (as the canvas offers them).
    const options = useMemo((): PickerOption[] => {
        const ownColumn = new Map(fill.layers.filter(l => l.anchorUrn && l.id !== layer.id).map(l => [l.anchorUrn!, l.name]))
        const columnNames = new Map(fill.layers.map(l => [l.id, l.name]))
        return entities
            .filter(e => e.urn !== layer.anchorUrn)
            .map(e => {
                const at = fill.assignments[e.urn]?.layerId
                const own = ownColumn.get(e.urn)
                const detail = own ? `Has its own column — moves here from “${own}”`
                    : at === layer.id ? 'In this column'
                        : at ? `In ${columnNames.get(at) ?? 'another column'}` : undefined
                return { option: { id: e.urn, label: e.name, badge: typeOf(typesByFold, e.type)?.name ?? e.type, detail }, here: at === layer.id }
            })
            .sort((a, b) => Number(b.here) - Number(a.here) || a.option.label.localeCompare(b.option.label))
            .map(o => o.option)
    }, [entities, fill.layers, fill.assignments, layer.id, layer.anchorUrn, typesByFold])

    const typeNames = (layer.entityTypes ?? []).map(typeName)
    const caption = shown === 'byType'
        ? (typeNames.length > 0 || (layer.rules ?? []).length > 0
            ? columnKindCopy('byType', {
                persona, where: 'there', typeNames,
                typePlurals: (layer.entityTypes ?? []).map(t => { const et = typeOf(typesByFold, t); return et?.pluralName || `${et?.name ?? t}s` }),
                ruleCount: (layer.rules ?? []).length,
                handPlaced: Object.values(fill.assignments).filter(a => a.layerId === layer.id).length,
            }).detail
            : 'Choose the types whose entities fill it.')
        : shown === 'handPicked'
            ? `Holds only what you place in it, ${placedWhere}.`
            : picking
                ? 'The column becomes that entity: its rows are what’s inside it, and adding or dropping there puts things inside it — which changes the data.'
                : null

    return (
        <div className="space-y-2.5">
            <span className="block text-xs font-medium text-slate-500 uppercase">Source</span>
            <div
                role="radiogroup"
                aria-label={`What fills ${layer.name}`}
                className="flex w-full gap-1 rounded-xl bg-slate-100/80 dark:bg-slate-900/70 p-1 ring-1 ring-inset ring-slate-200 dark:ring-slate-700/70"
            >
                {SOURCES.map(s => {
                    const Icon = COLUMN_KIND_ICON[s.id]
                    const on = shown === s.id
                    return (
                        <button
                            key={s.id}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => choose(s.id)}
                            className={cn(
                                'flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 h-8 px-2 rounded-lg text-xs font-medium transition-colors',
                                on
                                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm ring-1 ring-slate-200/80 dark:ring-slate-600/80'
                                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-white/60 dark:hover:bg-slate-800/50',
                            )}
                        >
                            <Icon className={cn('w-3.5 h-3.5 shrink-0', on ? 'text-indigo-600 dark:text-indigo-400' : 'opacity-70')} aria-hidden />
                            <span className="truncate">{s.label}</span>
                        </button>
                    )
                })}
            </div>
            {caption && <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{caption}</p>}

            {shown === 'byType' && (
                <div className="flex flex-wrap gap-1.5 min-h-[32px]">
                    {entityTypes.map(et => {
                        const active = (layer.entityTypes ?? []).includes(et.id)
                        return (
                            <button
                                key={et.id}
                                type="button"
                                onClick={() => onChange({
                                    ...fill,
                                    layers: fill.layers.map(l => (l.id !== layer.id ? l : {
                                        ...l,
                                        entityTypes: active ? (l.entityTypes ?? []).filter(id => id !== et.id) : [...(l.entityTypes ?? []), et.id],
                                    })),
                                })}
                                className={cn(
                                    'px-2 py-1 text-xs rounded-full border transition-colors',
                                    active
                                        ? 'border-transparent text-white'
                                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700',
                                )}
                                style={active ? { backgroundColor: et.visual.color } : undefined}
                            >
                                {et.name}
                            </button>
                        )
                    })}
                    {entityTypes.length === 0 && (
                        <span className="text-xs text-slate-400 italic">No entity types in ontology yet</span>
                    )}
                </div>
            )}

            {shown === 'mapped' && picking && (
                <div className="space-y-2">
                    {what && (
                        <p className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
                            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
                            <span>{`Mapping it stops it filling with ${what}: ${pullReason(layer, typesByFold)}.`}</span>
                        </p>
                    )}
                    {entitiesLoading ? (
                        <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-2 animate-pulse" aria-label="Loading top-level entities">
                            {[0, 1, 2].map(i => <div key={i} className="h-3 rounded bg-slate-100 dark:bg-slate-700/60" style={{ width: `${70 - i * 15}%` }} />)}
                        </div>
                    ) : (
                        <EntitySearchPicker
                            options={options}
                            onPick={pick}
                            onCancel={() => setPicking(false)}
                            searchLabel="Search for an entity to map it to"
                            listLabel="Top-level entities"
                            placeholder={`Search ${options.length.toLocaleString()} top-level entities…`}
                            emptyText="Your data has no top-level entities to map it to yet."
                            autoFocus
                        />
                    )}
                    {entitiesCapped && !entitiesLoading && (
                        <p className="text-[11px] text-slate-400">Lists the first {ENTITY_COLUMNS_MAX} of each type.</p>
                    )}
                </div>
            )}

            {shown === 'mapped' && !picking && anchorName && (
                <div className="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/40 px-3 py-2">
                    <span className="grid place-items-center w-7 h-7 rounded-lg bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 shrink-0">
                        <Link2 className="w-3.5 h-3.5" aria-hidden />
                    </span>
                    <span className="flex-1 min-w-0 text-sm text-slate-800 dark:text-slate-100 truncate">
                        {anchorName}
                        <span className="text-slate-400 dark:text-slate-500">{entityTypeOf(entities, layer.anchorUrn!, typeName)}</span>
                    </span>
                    <button
                        type="button"
                        onClick={() => { setNotice(null); setPicking(true) }}
                        className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 transition-colors"
                    >
                        Map to another entity…
                    </button>
                </div>
            )}

            {notice && undoable && (
                <div role="status" className="flex items-start gap-2 rounded-lg border border-indigo-200/80 dark:border-indigo-800/60 bg-indigo-50/60 dark:bg-indigo-950/30 px-3 py-2">
                    <Check className="w-3.5 h-3.5 mt-0.5 text-indigo-600 dark:text-indigo-400 shrink-0" aria-hidden />
                    <p className="flex-1 min-w-0 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{notice.text}</p>
                    <button type="button" onClick={undo} className="shrink-0 text-xs font-semibold text-indigo-700 dark:text-indigo-300 hover:underline">
                        Undo
                    </button>
                </div>
            )}
        </div>
    )
}

/** " · Domain" — the type of the entity a column is mapped to, when it is known. */
function entityTypeOf(entities: readonly TopLevelEntity[], urn: string, typeName: (id: string) => string): string {
    const type = entities.find(e => e.urn === urn)?.type
    return type ? ` · ${typeName(type)}` : ''
}
