/**
 * LayerSourceField — the Layout step's answer to "what fills this layer?", in the layer editor:
 * one segmented control (By type · Hand-picked · Mapped to an entity), what the chosen source
 * means for the column on the canvas, and what choosing it needs — the types, or the entity.
 *
 * A switch that drops something (its types, its mapping) is made at once and says what it
 * dropped, with an Undo — as the canvas's own column gestures do. Mapping waits for an entity to
 * be picked, and says before then what it will drop and why. On a brand-new model there is no
 * entity to pick: the column is mapped to a new one, of a root type and named here, made with the
 * model. The kinds and their wording are the canvas's (`columnKind`); what each switch writes is
 * `layerSource`.
 */
import { useId, useMemo, useState } from 'react'
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
    layerSourceOf, listOf, newRootProblemText, toByType, toEntity, toHandPicked, toNewRoot,
    type LayerFillState, type LayerSource, type NewRoot, type NewRootProblem,
} from '../layerSource'

const SOURCES: Array<{ id: LayerSource; label: string }> = [
    { id: 'byType', label: 'By type' },
    { id: 'handPicked', label: 'Hand-picked' },
    { id: 'mapped', label: 'Mapped to an entity' },
]

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

/** Named for the types it fills with ("Domains"): a name for its fill, not one someone gave it. */
function namedForTypes(layer: ViewLayerConfig, typesByFold: Map<string, EntityTypeSchema>): boolean {
    const name = caseFold(layer.name.trim())
    return !!name && (layer.entityTypes ?? []).some(t => {
        const et = typeOf(typesByFold, t)
        return [t, et?.name, et?.pluralName].some(n => !!n && caseFold(n) === name)
    })
}

const unmappedNotice = (name: string) => `${name} shows as a row now — the column is no longer mapped to it.`
const droppedRootNotice = (typeName: string, name: string) => name.trim()
    ? `The new ${typeName} “${name.trim()}” won’t be made.`
    : `No new ${typeName} will be made for it.`

const FIELD = 'h-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-100'

export function LayerSourceField({
    layer, fill, onChange, entityTypes, typesByFold, entities, entitiesLoading, entitiesCapped, nameOf, persona, placedWhere,
    rootTypes, problem,
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
    /** A brand-new model (no entities yet): the root types a new entity of its own can be. */
    rootTypes?: ReadonlyArray<{ id: string; name: string }>
    /** Why its new entity cannot be made as it is. */
    problem?: NewRootProblem
}) {
    const problemId = useId()
    // An unnamed new entity is said so once its name has been left empty, not before it is typed.
    const [nameTouched, setNameTouched] = useState(false)
    const [picking, setPicking] = useState(false)
    // "By type" chosen for a layer nothing fills yet: its types come next.
    const [byTypeChosen, setByTypeChosen] = useState(false)
    // What the last switch dropped: undone while nothing else has changed since.
    const [notice, setNotice] = useState<{ text: string; before: LayerFillState; after: LayerFillState } | null>(null)
    const undoable = !!notice && notice.after.layers === fill.layers && notice.after.assignments === fill.assignments
        && notice.after.newRoots === fill.newRoots

    const newRoot: NewRoot | undefined = fill.newRoots?.[layer.id]
    const current = layerSourceOf(layer, newRoot)
    const shown: LayerSource = picking ? 'mapped' : byTypeChosen && current === 'handPicked' ? 'byType' : current
    const anchorName = layer.anchorUrn ? nameOf(layer.anchorUrn) : null
    const what = fillsWith(layer, typesByFold)
    const typeName = (id: string) => typeOf(typesByFold, id)?.name ?? id
    /** What a switch away from mapped says it dropped. */
    const unmapping = anchorName ? unmappedNotice(anchorName) : newRoot ? droppedRootNotice(typeName(newRoot.type), newRoot.name) : null

    const commit = (next: LayerFillState, text: string | null) => {
        setNotice(text ? { text, before: fill, after: next } : null)
        onChange(next)
    }

    const choose = (to: LayerSource) => {
        if (to === shown) return
        setPicking(false)
        setByTypeChosen(false)
        if (to === 'mapped' && rootTypes) {
            // Its own root type when it fills with one, else the ontology's first.
            const own = rootTypes.find(t => (layer.entityTypes ?? []).some(id => caseFold(id) === caseFold(t.id)))
            commit(toNewRoot(fill, layer.id, { type: (own ?? rootTypes[0]).id, name: '' }, { takeName: namedForTypes(layer, typesByFold) }),
                what ? `No longer fills with ${what}: ${pullReason(layer, typesByFold)}.` : null)
            return
        }
        if (to === 'mapped') {
            setNotice(null)
            setPicking(true)
            return
        }
        if (to === 'byType') {
            setByTypeChosen(true)
            if (unmapping) commit(toByType(fill, layer.id, anchorName ?? undefined), unmapping)
            return
        }
        if (current === 'handPicked') return
        commit(toHandPicked(fill, layer.id, anchorName ?? undefined),
            unmapping ?? `No longer fills with ${what} — it holds only what’s placed in it.`)
    }

    const pick = (urn: string) => {
        const name = nameOf(urn)
        const next = toEntity(fill, layer.id, urn, name, { takeName: namedForTypes(layer, typesByFold) })
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
            // Mapped, the row above says what the column is.
            : picking || (newRoot && !newRoot.name.trim())
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
                    // A brand-new model whose ontology names no top-level type has nothing to map to.
                    const off = s.id === 'mapped' && !!rootTypes && rootTypes.length === 0
                    return (
                        <button
                            key={s.id}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            disabled={off}
                            title={off ? 'Your semantic layer names no top-level type to make one of' : undefined}
                            onClick={() => choose(s.id)}
                            className={cn(
                                'flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 h-8 px-2 rounded-lg text-xs font-medium transition-colors',
                                on
                                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm ring-1 ring-slate-200/80 dark:ring-slate-600/80'
                                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-white/60 dark:hover:bg-slate-800/50',
                                off && 'opacity-50 cursor-not-allowed',
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

            {shown === 'mapped' && newRoot && rootTypes && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/40 p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">A new</span>
                        {rootTypes.length > 1 ? (
                            <select
                                aria-label="Type of the new entity"
                                value={newRoot.type}
                                onChange={e => onChange(toNewRoot(fill, layer.id, { ...newRoot, type: e.target.value }))}
                                className={cn(FIELD, 'px-2 pr-7')}
                            >
                                {rootTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                        ) : (
                            <span className="inline-flex items-center h-8 px-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm text-slate-800 dark:text-slate-100">
                                {typeName(newRoot.type)}
                            </span>
                        )}
                        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">named</span>
                        <input
                            type="text"
                            aria-label={`Name of the new ${typeName(newRoot.type)}`}
                            aria-invalid={!!problem}
                            aria-describedby={problem ? problemId : undefined}
                            value={newRoot.name}
                            onChange={e => onChange(toNewRoot(fill, layer.id, { ...newRoot, name: e.target.value }))}
                            onBlur={() => setNameTouched(true)}
                            placeholder="e.g. Finance"
                            autoFocus
                            className={cn(FIELD, 'flex-1 min-w-[10rem] px-2.5',
                                problem && 'border-amber-400 dark:border-amber-600 focus:outline-amber-500')}
                        />
                    </div>
                    {problem && (problem === 'taken' || nameTouched) && (
                        <p id={problemId} className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden />
                            {newRootProblemText(problem, typeName(newRoot.type), newRoot.name)}
                        </p>
                    )}
                    <p className="text-[11px] text-slate-400 dark:text-slate-500">
                        Made in the new model’s draft when you create it, with this column mapped to it.
                    </p>
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
                        <div className="rounded-xl bg-white dark:bg-slate-900 ring-1 ring-slate-200 dark:ring-slate-700">
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
                        </div>
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
