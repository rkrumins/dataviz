/**
 * LayoutStep - Second wizard step for layout type selection and layer configuration
 * 
 * Beautiful card-based layout selection with recommended badge
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import {
    Check,
    Plus,
    GripVertical,
    Trash2,
    ChevronDown,
    ChevronRight,
    Wand2,
    Sparkles,
    Repeat,
    Layers,
    LayoutTemplate,
    Search,
    Save,
    Home,
    MousePointerClick,
} from 'lucide-react'
import { cn, generateId } from '@/lib/utils'
import type { WizardFormData } from '../ViewWizard'
import type { EntityTypeSchema, LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import { useDataSourceSchema } from '@/hooks/useDataSourceSchema'
import { useLayoutTemplate, useLayoutTemplates, useLayoutTemplatesEnabled } from '@/hooks/useLayoutTemplates'
import { caseFold } from '@/features/ontology/lib/caseFold'
import { useSchemaEntityTypes, useSchemaStore } from '@/store/schema'
import type { LayoutTemplate as LibraryTemplate } from '@/services/layoutTemplateService'
import { TemplatePreview } from '@/components/templates/TemplatePreview'
import { SaveAsTemplateDialog } from '@/components/templates/SaveAsTemplateDialog'
import { HoverTip } from '@/components/ui/HoverTip'
import { fitTargetOf, layersForView, suggestFills, type LayerFill } from '@/components/templates/templateFit'
import { LAYER_COLORS } from '../layerColors'
import { AUDIENCE, LIBRARY_TABS, audienceOf, type LibraryTab, type TemplateAudience } from '@/components/templates/templateAudience'
import { blankQuickStartTemplates } from '../blankTemplates'
import { deriveLayersFromOntology } from '../blankModel'
import {
    deriveRootTypeCandidates, layersForRootTypes, layersForTopLevelEntities, type RootTypeCandidate, type TopLevelEntity,
} from '../autoLayers'
import { ENTITY_COLUMNS_MAX, ENTITY_COLUMNS_WARN, useTopLevelEntities, type TopLevelOfType } from '../useTopLevelEntities'

// ============================================
// Types
// ============================================

interface LayoutStepProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
    layoutTypes: {
        id: 'graph' | 'hierarchy' | 'reference'
        label: string
        icon: React.ReactNode
        description: string
        features: string[]
        recommended?: boolean
    }[]
    /** Data source whose assigned ontology scopes the entity type picker. */
    dataSourceId?: string
    /** Blank model: no data source yet — read entity types from the hydrated schema store. */
    blank?: boolean
    /** The layers came from an imported file. No Quick Start: a template replaces the layers
     *  and so unplaces everything the file placed. */
    imported?: boolean
    /** Opened from a library template ("Use template"), or the workspace's default:
     *  apply it once, as soon as the semantic layer it is matched against is known. */
    initialTemplateId?: string
    /** Told once `initialTemplateId` is applied, so a later visit to this step
     *  never applies it over what the person chose since. */
    onInitialTemplateApplied?: () => void
    /** The workspace's default template, when the view started from it. */
    workspaceDefault?: { templateId: string; workspaceName: string }
}

export { LAYER_COLORS } from '../layerColors'

const NONE: never[] = []

// ============================================
// Quick Start template gallery
// ============================================

/** One template offering, whatever its origin (blank Quick Start, ontology-derived,
 *  or the template library). The gallery renders all of them identically so both
 *  creation flows share one visual language. */
interface GalleryTemplate {
    id: string
    name: string
    description: string
    category?: string
    recommended?: boolean
    layers: Array<Partial<ViewLayerConfig> & { name: string }>
    /** A library template: who it is for. */
    audience?: TemplateAudience
    /** Pin the view's entity scope when the template's layers only work under one.
     *  A template whose layers carry `entityTypes` places entities BY RULE and
     *  writes no assignments — that resolves only in open ('all') scope, and
     *  `deriveEntityScope` would otherwise flip the view to 'curated' the moment
     *  the user drags a single entity, emptying every other column. */
    entityScope?: 'all' | 'curated'
}

/** "2 layers: Domains, Teams" — a long list trimmed so the card stays a card. */
function describeList(count: number, noun: string, names: string[], shown = 4): string {
    const listed = names.slice(0, shown).join(', ')
    return `${count} ${noun}${count === 1 ? '' : 's'}: ${listed}${count > shown ? ', …' : ''}`
}

/** Gallery of Quick Start templates — one card per template with a mini preview,
 *  description, category chip, and selected state. Shared by BOTH creation flows.
 *  `before`/`after`: cards of their own (the ones with choices on them) in the
 *  same grid. */
function TemplateGallery({
    templates,
    activeId,
    loading,
    onApply,
    before,
    after,
}: {
    templates: GalleryTemplate[]
    activeId?: string
    loading?: boolean
    onApply: (template: GalleryTemplate) => void
    before?: React.ReactNode
    after?: React.ReactNode
}) {
    if (loading) {
        return (
            <div className="grid gap-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 p-4 animate-pulse">
                        <div className="h-3 w-2/3 bg-slate-200 dark:bg-slate-600 rounded mb-2" />
                        <div className="h-2 w-full bg-slate-100 dark:bg-slate-700 rounded mb-4" />
                        <div className="flex gap-1.5">
                            {Array.from({ length: 3 }).map((_, j) => (
                                <div key={j} className="h-8 flex-1 bg-slate-100 dark:bg-slate-700 rounded-md" />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        )
    }
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            {before}
            {templates.map(template => {
                const active = template.id === activeId
                return (
                    <button
                        key={template.id}
                        type="button"
                        onClick={() => onApply(template)}
                        className={cn(
                            'relative text-left rounded-xl border-2 p-4 transition-colors duration-150 hover:shadow-md',
                            active
                                ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 shadow-sm shadow-blue-500/10'
                                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 hover:border-slate-300 dark:hover:border-slate-600',
                        )}
                    >
                        {template.recommended && (
                            <span className="absolute -top-2 -right-2 inline-flex items-center gap-0.5 px-2 py-0.5 text-[10px] font-semibold bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-full shadow">
                                <Sparkles className="w-3 h-3" /> Recommended
                            </span>
                        )}
                        <div className="flex items-center justify-between gap-2 mb-1">
                            <h5 className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">{template.name}</h5>
                            <span className="text-[10px] text-slate-400 shrink-0">
                                {template.layers.length > 0
                                    ? `${template.layers.length} layer${template.layers.length !== 1 ? 's' : ''}`
                                    : 'no layers'}
                            </span>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 leading-snug mb-3">
                            {template.description}
                        </p>
                        <TemplatePreview layers={template.layers} active={active} />
                        {(template.category || template.audience) && (
                            <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                                {template.audience && (
                                    <span className={cn('px-1.5 py-0.5 text-[10px] font-semibold rounded border', AUDIENCE[template.audience].badge)}>
                                        {AUDIENCE[template.audience].label}
                                    </span>
                                )}
                                {template.category && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-medium bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded capitalize">
                                        {template.category.replace(/-/g, ' ')}
                                    </span>
                                )}
                            </div>
                        )}
                    </button>
                )
            })}
            {after}
        </div>
    )
}

// ============================================
// Layers from the top of the data
// ============================================

/** One root type offered as a chip: its name, and how many entities it has when known. */
interface RootTypeOption {
    id: string
    name: string
    count?: number | null
    over?: boolean
}

function TypeChips({ label, options, selected, onToggle }: {
    label: string
    options: RootTypeOption[]
    selected: ReadonlySet<string>
    onToggle: (id: string) => void
}) {
    return (
        <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
            {options.map(o => {
                const on = selected.has(o.id)
                const empty = o.count === 0
                const count = o.over ? `${ENTITY_COLUMNS_MAX}+` : o.count != null ? o.count.toLocaleString() : null
                return (
                    <button
                        key={o.id}
                        type="button"
                        aria-label={count ? `${o.name} · ${count}` : o.name}
                        aria-pressed={on}
                        disabled={empty}
                        onClick={() => onToggle(o.id)}
                        className={cn(
                            'inline-flex items-center h-6 px-2.5 rounded-full border text-[11px] font-medium transition-colors',
                            on
                                ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-200'
                                : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50',
                            empty && 'opacity-50 cursor-not-allowed',
                        )}
                    >
                        {on && <Check className="w-3 h-3 mr-1" aria-hidden />}
                        {o.name}
                        {count && <span className="ml-1 tabular-nums opacity-70" aria-hidden>· {count}</span>}
                    </button>
                )
            })}
        </div>
    )
}

/** The frame the cards with choices on them share with the gallery's. */
function ChoiceCard({ label, title, count, recommended, active, children }: {
    /** Stable name for the card, whatever its title says just now. */
    label: string
    title: string
    count: string
    recommended?: boolean
    active?: boolean
    children: React.ReactNode
}) {
    return (
        <div
            role="group"
            aria-label={label}
            className={cn(
                'relative rounded-xl border-2 p-4 transition-colors duration-150',
                active
                    ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 shadow-sm shadow-blue-500/10'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60',
            )}
        >
            {recommended && (
                <span className="absolute -top-2 -right-2 inline-flex items-center gap-0.5 px-2 py-0.5 text-[10px] font-semibold bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-full shadow">
                    <Sparkles className="w-3 h-3" /> Recommended
                </span>
            )}
            <div className="flex items-center justify-between gap-2 mb-1">
                <h5 className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">{title}</h5>
                <span className="text-[10px] text-slate-400 shrink-0">{count}</span>
            </div>
            {children}
        </div>
    )
}

const CREATE = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
const QUIET = 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors'

/** One layer per root type, for the types chosen — all of them to begin with. */
function PerTypeCard({ candidates, options, recommended, active, onCreate }: {
    candidates: RootTypeCandidate[]
    options: RootTypeOption[]
    recommended: boolean
    active: boolean
    onCreate: (chosen: RootTypeCandidate[]) => void
}) {
    const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.map(c => c.typeId)))
    const chosen = candidates.filter(c => selected.has(c.typeId))
    const layers = layersForRootTypes(chosen)
    const toggle = (id: string) => setSelected(prev => {
        const next = new Set(prev)
        if (!next.delete(id)) next.add(id)
        return next
    })
    return (
        <ChoiceCard
            label="One layer per top-level type"
            title="One layer per top-level type"
            count={`${chosen.length} layer${chosen.length === 1 ? '' : 's'}`}
            recommended={recommended}
            active={active}
        >
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-snug mb-2.5">
                {chosen.length > 0
                    ? `${describeList(chosen.length, 'layer', chosen.map(c => c.label))}. Each holds everything its entities contain.`
                    : 'Choose the top-level types to make layers for.'}
            </p>
            <TypeChips label="Top-level types" options={options} selected={selected} onToggle={toggle} />
            <div className="mt-3">
                <TemplatePreview layers={layers} active={active} />
            </div>
            <div className="flex justify-end mt-3">
                <button type="button" className={CREATE} disabled={chosen.length === 0} onClick={() => onCreate(chosen)}>
                    Create {chosen.length} layer{chosen.length === 1 ? '' : 's'}
                </button>
            </div>
        </ChoiceCard>
    )
}

/** A root type and the top-level entities it has. */
type EntityTypeTop = TopLevelOfType & { id: string; name: string; plural: string }

/**
 * One column per top-level entity of the types chosen — the largest such type
 * to begin with. Up to `ENTITY_COLUMNS_WARN` columns, the person can leave
 * some out before they are made; more asks first; past `ENTITY_COLUMNS_MAX`
 * nothing is made, with the reason.
 */
function PerEntityCard({ types, initialType, recommended, active, onCreate }: {
    types: EntityTypeTop[]
    initialType: string
    recommended: boolean
    active: boolean
    onCreate: (entities: TopLevelEntity[]) => void
}) {
    const [selected, setSelected] = useState<Set<string>>(() => new Set([initialType]))
    const [step, setStep] = useState<'choose' | 'confirm'>('choose')
    const [left, setLeft] = useState<Set<string>>(() => new Set())
    const chosenTypes = types.filter(t => selected.has(t.id))
    const over = chosenTypes.some(t => t.over)
    const total = chosenTypes.reduce((n, t) => n + (t.count ?? t.entities.length), 0)
    const entities = chosenTypes.flatMap(t => t.entities).sort((a, b) => a.name.localeCompare(b.name))
    const kept = entities.filter(e => !left.has(e.urn))
    const toggle = (id: string) => {
        setStep('choose')
        setSelected(prev => {
            const next = new Set(prev)
            if (!next.delete(id)) next.add(id)
            return next
        })
    }
    const title = chosenTypes.length === 1
        ? total === 1 ? `One column for ${entities[0]?.name ?? chosenTypes[0].name}` : `One column per ${chosenTypes[0].name}`
        : chosenTypes.length > 1 ? `One column per top-level entity (${over ? `${ENTITY_COLUMNS_MAX}+` : total})` : 'One column per top-level entity'
    const create = () => {
        if (total === 1) onCreate(entities)
        else setStep('confirm')
    }
    const columns = (n: number) => `${n} column${n === 1 ? '' : 's'}`
    return (
        <ChoiceCard
            label="One column per top-level entity"
            title={title}
            count={over ? `${ENTITY_COLUMNS_MAX}+ columns` : columns(total)}
            recommended={recommended}
            active={active}
        >
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-snug mb-2.5">
                {chosenTypes.length === 0 ? 'Choose the top-level types whose entities become columns.'
                    : over ? `More than ${ENTITY_COLUMNS_MAX} columns are too many to read side by side. Choose fewer types, or use one layer per top-level type.`
                        : total === 1 ? `One column, holding everything ${entities[0]?.name} contains.`
                            : `${describeList(total, 'column', entities.map(e => e.name), 3)}. Each holds everything its entity contains.`}
            </p>
            <TypeChips label="Top-level types" options={types} selected={selected} onToggle={toggle} />
            {step === 'choose' ? (
                <>
                    <div className="mt-3">
                        <TemplatePreview layers={entities.slice(0, 6).map(e => ({ id: e.urn, name: e.name }))} active={active} />
                    </div>
                    {!over && total > 0 && (
                        <div className="flex justify-end mt-3">
                            <button type="button" className={CREATE} onClick={create}>Create {columns(total)}</button>
                        </div>
                    )}
                </>
            ) : total > ENTITY_COLUMNS_WARN ? (
                <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 p-3">
                    <p className="text-xs text-slate-600 dark:text-slate-300">
                        {total} columns make a wide view: it scrolls sideways. Create them anyway?
                    </p>
                    <div className="flex justify-end gap-2 mt-2.5">
                        <button type="button" className={QUIET} onClick={() => setStep('choose')}>Back</button>
                        <button type="button" className={CREATE} onClick={() => onCreate(entities)}>Create {columns(total)}</button>
                    </div>
                </div>
            ) : (
                <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 p-3">
                    <p className="text-xs text-slate-600 dark:text-slate-300 mb-2">Leave out any you don't want.</p>
                    <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
                        {entities.map(e => (
                            <li key={e.urn}>
                                <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer min-w-0">
                                    <input
                                        type="checkbox"
                                        checked={!left.has(e.urn)}
                                        onChange={() => setLeft(prev => {
                                            const next = new Set(prev)
                                            if (!next.delete(e.urn)) next.add(e.urn)
                                            return next
                                        })}
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600"
                                    />
                                    <span className="truncate">{e.name}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                    <div className="flex justify-end gap-2 mt-2.5">
                        <button type="button" className={QUIET} onClick={() => setStep('choose')}>Back</button>
                        <button type="button" className={CREATE} disabled={kept.length === 0} onClick={() => onCreate(kept)}>
                            Create {columns(kept.length)}
                        </button>
                    </div>
                </div>
            )}
        </ChoiceCard>
    )
}

// ============================================
// What fills a layer
// ============================================

const sameTypes = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(t => b.includes(t))

/** Whether a layer is filled other than by its types: by a rule, as one entity's
 *  column, or with entities placed in it by hand. */
function placedOtherwise(layer: ViewLayerConfig, assignments: Record<string, LayerAssignmentEntry>): boolean {
    return !!layer.anchorUrn
        || (layer.rules ?? []).length > 0
        || Object.values(assignments).some(a => a.layerId === layer.id)
}

/** A type as the layer list names it: its plural name, else its id. */
function typeLabel(typesByFold: Map<string, EntityTypeSchema>, id: string): string {
    const et = typesByFold.get(caseFold(id))
    return et ? (et.pluralName || et.name) : id
}

/** Under a layer's name: the types that fill it, marked while they are still a
 *  suggestion taken from the graph — or, when nothing fills it, an invitation to
 *  choose, with the graph's offer beside it when it has one. Read from the layer
 *  as it is now, so an edit shows at once. */
function LayerFillRow({ layer, suggestion, offer, typesByFold, placed, canChoose, onKeep, onChoose, onTakeOffer }: {
    layer: ViewLayerConfig
    suggestion?: LayerFill
    /** What the graph could fill this open layer with. */
    offer?: LayerFill
    typesByFold: Map<string, EntityTypeSchema>
    placed: boolean
    canChoose: boolean
    onKeep: () => void
    onChoose: () => void
    onTakeOffer: () => void
}) {
    const types = layer.entityTypes ?? []
    if (types.length > 0) {
        const suggested = !!suggestion && sameTypes(suggestion.types, types)
        return (
            <div className="flex flex-wrap items-center gap-1.5 pl-[4.75rem] pr-4 pb-3 -mt-1.5">
                <span className="text-[11px] text-slate-400 dark:text-slate-500 mr-0.5">Fills with</span>
                {types.map(t => {
                    const et = typesByFold.get(caseFold(t))
                    return (
                        <span key={t} className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 text-[11px] font-medium text-slate-700 dark:text-slate-200">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: et?.visual?.color ?? '#94a3b8' }} aria-hidden />
                            {typeLabel(typesByFold, t)}
                        </span>
                    )
                })}
                {suggested && (
                    <span className="inline-flex items-center gap-1 ml-1">
                        <HoverTip
                            label={suggestion.by === 'level'
                                ? "By order: the layer's place follows your hierarchy, top level first"
                                : 'By name: your graph has a type of this name'}
                            detail="Keep it, or change it in place."
                        >
                            <span className="inline-flex items-center gap-1 px-2 h-6 rounded-full bg-indigo-50 dark:bg-indigo-500/10 text-[11px] font-medium text-indigo-600 dark:text-indigo-300">
                                <Sparkles className="w-3 h-3" aria-hidden />
                                Suggested from your data
                            </span>
                        </HoverTip>
                        <button
                            type="button"
                            onClick={onKeep}
                            className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        >
                            <Check className="w-3 h-3" aria-hidden />
                            Keep
                        </button>
                        <button
                            type="button"
                            onClick={onChoose}
                            className="inline-flex items-center h-6 px-2 rounded-full text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        >
                            Change
                        </button>
                    </span>
                )}
            </div>
        )
    }
    if (placed) return null
    const offered = offer?.types.map(t => typeLabel(typesByFold, t)).join(' + ')
    return (
        <div className="pl-[4.75rem] pr-4 pb-3 -mt-1.5">
            {canChoose ? (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 dark:border-slate-600 p-1">
                    <button
                        type="button"
                        onClick={onChoose}
                        className="flex-1 min-w-0 flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-slate-500 dark:text-slate-400 hover:bg-indigo-50/60 hover:text-indigo-700 dark:hover:bg-indigo-950/30 dark:hover:text-indigo-300 transition-colors"
                    >
                        <MousePointerClick className="w-3.5 h-3.5 shrink-0" aria-hidden />
                        <span className="truncate">Choose what fills this layer — or place entities in it by hand</span>
                    </button>
                    {offered && (
                        <HoverTip
                            label={offer!.by === 'level'
                                ? "By order: the layer's place follows your hierarchy, top level first"
                                : 'By name: your graph has a type of this name'}
                        >
                            <button
                                type="button"
                                onClick={onTakeOffer}
                                aria-label={`Fill ${layer.name} with ${offered}`}
                                className="shrink-0 inline-flex items-center gap-1 h-6 px-2.5 rounded-full bg-indigo-50 dark:bg-indigo-500/10 text-[11px] font-medium text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 transition-colors"
                            >
                                <Sparkles className="w-3 h-3" aria-hidden />
                                Suggest: {offered}
                            </button>
                        </HoverTip>
                    )}
                </div>
            ) : (
                <p className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 dark:border-slate-600 px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                    <MousePointerClick className="w-3.5 h-3.5 shrink-0" aria-hidden />
                    Place entities in this layer by hand on the next step
                </p>
            )}
        </div>
    )
}

/** "Suggest from your graph": what the graph could fill each open layer with,
 *  shown before anything changes; the person unticks what they don't want. */
function SuggestionReview({ layers, offers, ticked, typesByFold, onToggle, onApply, onClose }: {
    layers: ViewLayerConfig[]
    offers: Record<string, LayerFill>
    ticked: ReadonlySet<string>
    typesByFold: Map<string, EntityTypeSchema>
    onToggle: (layerId: string) => void
    onApply: () => void
    onClose: () => void
}) {
    const rows = layers.filter(l => offers[l.id])
    const count = rows.filter(l => ticked.has(l.id)).length
    return (
        <section
            aria-label="Suggested from your graph"
            className="rounded-xl border border-indigo-200 dark:border-indigo-800/70 bg-gradient-to-br from-indigo-50/80 to-violet-50/50 dark:from-indigo-950/40 dark:to-violet-950/20 p-4 space-y-3"
        >
            <div className="flex items-start gap-2.5">
                <Wand2 className="w-4 h-4 mt-0.5 text-indigo-600 dark:text-indigo-400 shrink-0" aria-hidden />
                <div className="min-w-0">
                    <h5 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Suggested from your graph</h5>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                        {rows.length > 0
                            ? "Types in your graph for the layers nothing fills yet — by name, else by your hierarchy's levels. Untick any you don't want."
                            : 'Nothing to suggest: no type left in your graph fits the open layers by name or by level. Choose what fills each one below, or place entities in them by hand.'}
                    </p>
                </div>
            </div>
            {rows.length > 0 && (
                <ul className="rounded-lg border border-indigo-100 dark:border-indigo-900/60 bg-white/70 dark:bg-slate-900/50 divide-y divide-indigo-100/70 dark:divide-indigo-900/50">
                    {rows.map(layer => {
                        const offer = offers[layer.id]
                        const labels = offer.types.map(t => typeLabel(typesByFold, t))
                        return (
                            <li key={layer.id}>
                                <label className="flex items-center gap-3 px-3 py-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={ticked.has(layer.id)}
                                        onChange={() => onToggle(layer.id)}
                                        aria-label={`${layer.name}: ${labels.join(' + ')}`}
                                        className="rounded border-slate-300 dark:border-slate-600 text-indigo-600"
                                    />
                                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: layer.color }} aria-hidden />
                                    <span className="w-32 truncate text-xs font-medium text-slate-700 dark:text-slate-200">{layer.name}</span>
                                    <ChevronRight className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 shrink-0" aria-hidden />
                                    <span className="flex flex-wrap gap-1 flex-1 min-w-0">
                                        {offer.types.map(t => (
                                            <span key={t} className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-medium text-slate-700 dark:text-slate-200">
                                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: typesByFold.get(caseFold(t))?.visual?.color ?? '#94a3b8' }} aria-hidden />
                                                {typeLabel(typesByFold, t)}
                                            </span>
                                        ))}
                                    </span>
                                    <span className="shrink-0 text-[10px] text-slate-400">{offer.by === 'level' ? 'by level' : 'by name'}</span>
                                </label>
                            </li>
                        )
                    })}
                </ul>
            )}
            <div className="flex items-center justify-end gap-2">
                <button
                    type="button"
                    onClick={onClose}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-white/70 dark:hover:bg-slate-800 transition-colors"
                >
                    {rows.length > 0 ? 'Cancel' : 'Close'}
                </button>
                {rows.length > 0 && (
                    <button
                        type="button"
                        onClick={onApply}
                        disabled={count === 0}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        Apply {count} suggestion{count === 1 ? '' : 's'}
                    </button>
                )}
            </div>
        </section>
    )
}

// ============================================
// Component
// ============================================

export function LayoutStep({
    formData, updateFormData, layoutTypes, dataSourceId, blank, imported, initialTemplateId, onInitialTemplateApplied,
    workspaceDefault,
}: LayoutStepProps) {
    const [expandedLayerId, setExpandedLayerId] = useState<string | null>(null)
    // Blank models have no data source to probe; their ontology schema is hydrated
    // into the schema store, so read entity types from there instead.
    const {
        entityTypes: dsEntityTypes,
        relationshipTypes: dsRelationshipTypes,
        rootEntityTypes: dsRootEntityTypes,
        containmentEdgeTypes: dsContainmentEdgeTypes,
        isLoading: dsSchemaLoading,
    } = useDataSourceSchema(dataSourceId)
    const storeEntityTypes = useSchemaEntityTypes()
    const blankSchema = useSchemaStore(s => s.schema)
    const schemaEntityTypes = blank ? storeEntityTypes : dsEntityTypes
    const relationshipTypes = (blank ? blankSchema?.relationshipTypes : dsRelationshipTypes) ?? NONE
    const rootEntityTypes = (blank ? blankSchema?.rootEntityTypes : dsRootEntityTypes) ?? NONE
    const containmentEdgeTypes = (blank ? blankSchema?.containmentEdgeTypes : dsContainmentEdgeTypes) ?? NONE
    const availableEntityTypes = useMemo(
        () => schemaEntityTypes.slice().sort((a, b) => a.name.localeCompare(b.name)),
        [schemaEntityTypes]
    )
    const typesByFold = useMemo(() => new Map(schemaEntityTypes.map(et => [caseFold(et.id), et])), [schemaEntityTypes])

    // What a library template is fitted to: this data's types and hierarchy, or
    // null while it declares none (no ontology, an empty one, a failed read) —
    // a template's hints are then kept as written.
    const fitTarget = useMemo(
        () => fitTargetOf({ entityTypes: schemaEntityTypes, relationshipTypes, rootEntityTypes, containmentEdgeTypes }),
        [schemaEntityTypes, relationshipTypes, rootEntityTypes, containmentEdgeTypes],
    )

    // ── Quick Start templates (both creation flows) ───────────────────────────
    // Blank models: ontology + generic scaffolds from blankQuickStartTemplates.
    // Existing sources: an ontology-derived recommended template (their assigned
    // schema has levels too) ahead of the org's backend/local templates. Both
    // render through the same TemplateGallery.
    const blankTemplates = useMemo(
        () => (blank && blankSchema ? blankQuickStartTemplates(blankSchema) : []),
        [blank, blankSchema],
    )
    // Gallery stays open until a template is explicitly chosen, and re-opens when
    // the user switches. `layoutTemplateId` persists the choice across step nav.
    // Existing-source mode keeps its original semantics: the gallery shows while
    // there are no layers (no choice is REQUIRED — canProceed is unchanged there).
    const [galleryOpen, setGalleryOpen] = useState(false)
    const showGallery = !imported && (galleryOpen
        || (blank ? !formData.layoutTemplateId : formData.layers.length === 0))

    const handleSwitchTemplate = useCallback(() => {
        if (formData.layers.length > 0 && !window.confirm('Switching templates will replace your current layers. Continue?')) {
            return
        }
        setGalleryOpen(true)
    }, [formData.layers.length])

    // ── The template library ─────────────────────────────────────────────
    // Built-ins, the organization's, the workspace's and the person's own — one
    // cached list shared with the Templates page. Each is matched to THIS data's
    // semantic layer before it is offered, so the card can say how well it fits.
    const { templates: library, isLoading: libraryLoading } = useLayoutTemplates()
    const templatesOn = useLayoutTemplatesEnabled()
    const [libraryTab, setLibraryTab] = useState<LibraryTab>('all')
    const [libraryQuery, setLibraryQuery] = useState('')
    const [savingAsTemplate, setSavingAsTemplate] = useState(false)
    const libraryTabs = useMemo(
        () => LIBRARY_TABS.filter(tab => tab.id === 'all' || library.some(tab.match)),
        [library],
    )
    const libraryTemplates: GalleryTemplate[] = useMemo(() => {
        const q = libraryQuery.trim().toLowerCase()
        const inTab = LIBRARY_TABS.find(tab => tab.id === libraryTab)?.match ?? (() => true)
        return library
            .filter(t => inTab(t) && (!q || t.name.toLowerCase().includes(q)
                || (t.description ?? '').toLowerCase().includes(q)))
            .map(t => ({
                id: t.id,
                name: t.name,
                description: t.description ?? '',
                category: t.category ?? undefined,
                layers: t.layers,
                audience: audienceOf(t),
            }))
    }, [library, libraryTab, libraryQuery])

    // What the data itself suggests, per flow; the library follows it.
    // One layer per TOP-LEVEL type, so Domain and Root each get their own rather
    // than sharing a single level-0 column. Each layer carries its one
    // entityType, which IS the placement rule: every root of that type lands
    // there and its containment children inherit, with no per-entity assignment
    // written and no column to fill in by hand. Both flows: a brand-new model
    // knows its roots from its ontology alone.
    const rootTypeCandidates = useMemo(() => deriveRootTypeCandidates({
        entityTypes: schemaEntityTypes,
        relationshipTypes,
        rootEntityTypes,
        containmentEdgeTypes,
    }), [schemaEntityTypes, relationshipTypes, rootEntityTypes, containmentEdgeTypes])
    const rootTypeIds = useMemo(() => rootTypeCandidates.map(c => c.typeId), [rootTypeCandidates])

    // …and one COLUMN per top-level entity, read from the source while the
    // suggestions show: a brand-new model has no entities yet.
    const topLevel = useTopLevelEntities(dataSourceId, rootTypeIds, !blank && showGallery && !dsSchemaLoading)
    const entityTypesTop: EntityTypeTop[] = useMemo(() => rootTypeCandidates.flatMap(c => {
        const of = topLevel.byType.get(c.typeId)
        const et = typesByFold.get(caseFold(c.typeId))
        return of ? [{ ...of, id: c.typeId, name: et?.name ?? c.typeId, plural: c.label }] : []
    }), [rootTypeCandidates, topLevel.byType, typesByFold])
    const withEntities = entityTypesTop.filter(t => t.over || (t.count ?? t.entities.length) > 0)
    const columnable = withEntities.filter(t => !t.over)
    // The largest type a column each can be made for, to begin with.
    const firstEntityType = columnable.reduce<EntityTypeTop | null>(
        (best, t) => (!best || (t.count ?? 0) > (best.count ?? 0) ? t : best), null)
    // One root type with entities: a column per entity, not one column of them all.
    const entityColumnsFirst = withEntities.length === 1 && !!firstEntityType
    const tooMany = !firstEntityType ? withEntities.find(t => t.over) : undefined

    const suggestedTemplates: GalleryTemplate[] = useMemo(() => {
        if (blank) return blankTemplates

        const fromSchema: GalleryTemplate | null = schemaEntityTypes.length > 0 ? {
            id: 'from-schema',
            name: 'From your schema',
            description: 'One layer per level of your assigned ontology, with entity types pre-assigned.',
            category: 'schema',
            // Rule-driven exactly like the card above — its layers carry
            // entityTypes and no assignments, so it needs the same open scope.
            entityScope: 'all',
            layers: deriveLayersFromOntology({ entityTypes: schemaEntityTypes }),
        } : null

        return fromSchema ? [fromSchema] : []
    }, [blank, blankTemplates, schemaEntityTypes])

    // One apply path for every template origin: normalize layers (mint ids/orders,
    // default colors) and record the choice so the picker can be revisited.
    // Resets assignments to {} — a template's layers get fresh ids, so any prior
    // assignments (keyed to the OLD layer ids) would otherwise dangle. Never
    // copies assignments a template might carry; only layer STRUCTURE is copied.
    // The one exception: a column per entity brings the assignment that places it.
    const handleApplyGalleryTemplate = useCallback((template: GalleryTemplate, assignments: Record<string, LayerAssignmentEntry> = {}) => {
        // Template types are suggestions written for SOME ontology: keep only the ones
        // this data source's ontology declares, in its own spelling. A layer left with
        // none keeps its name and colour and is filled by assignment, like the local
        // fallbacks.
        const declared = new Map(schemaEntityTypes.map(et => [caseFold(et.id), et.id]))
        const layers: ViewLayerConfig[] = template.layers.map((l, i) => ({
            ...l,
            name: l.name,
            description: l.description ?? '',
            color: l.color ?? LAYER_COLORS[i % LAYER_COLORS.length],
            entityTypes: [...new Set((l.entityTypes ?? [])
                .map(t => declared.get(caseFold(t)))
                .filter((t): t is string => !!t))],
            id: l.id ?? generateId(),
            order: i,
        }))
        updateFormData({
            layers,
            assignments,
            layoutTemplateId: template.id,
            contextModelId: undefined,
            contextModelVersion: undefined,
            suggestedFills: undefined,
            entityScope: template.entityScope,
        })
        setGalleryOpen(false)
    }, [updateFormData, schemaEntityTypes])

    // A library template, as authored: every structural field kept, the types
    // this data declares (the rest dropped, or all kept when it declares none),
    // fresh layer ids, and the template recorded as where the view started.
    // Filling its open layers from the graph is an offer (`suggestFills`).
    const libraryTemplateUpdate = useCallback((template: Pick<LibraryTemplate, 'id' | 'layers' | 'version'>): Partial<WizardFormData> => {
        const layers = layersForView(template.layers, fitTarget)
        return {
            layoutType: 'reference',
            layers,
            assignments: {},
            layoutTemplateId: template.id,
            contextModelId: template.id,
            contextModelVersion: template.version,
            suggestedFills: undefined,
            // Layers that place by rule resolve only in open scope (see GalleryTemplate.entityScope).
            entityScope: layers.some(l => l.entityTypes.length > 0 || (l.rules?.length ?? 0) > 0) ? 'all' : undefined,
        }
    }, [fitTarget])

    const handleApplyLibraryTemplate = useCallback((template: Pick<LibraryTemplate, 'id' | 'layers' | 'version'>) => {
        updateFormData(libraryTemplateUpdate(template))
        setGalleryOpen(false)
    }, [updateFormData, libraryTemplateUpdate])

    // Opened from "Use template": apply it once, when both it and this data's
    // semantic layer are known. A hidden or unshared one is fetched on its own,
    // and one that cannot be read leaves the gallery open.
    const listedInitial = initialTemplateId ? library.find(t => t.id === initialTemplateId) : undefined
    const fetchedInitial = useLayoutTemplate(
        initialTemplateId && !libraryLoading && !listedInitial ? initialTemplateId : null,
    )
    const autoApplied = useRef(false)
    useEffect(() => {
        if (!initialTemplateId || autoApplied.current || imported) return
        if (formData.contextModelId === initialTemplateId) {
            autoApplied.current = true
            onInitialTemplateApplied?.()
            return
        }
        const template = listedInitial ?? fetchedInitial.data
        if (!template || dsSchemaLoading) return
        autoApplied.current = true
        updateFormData(libraryTemplateUpdate(template))
        onInitialTemplateApplied?.()
    }, [
        initialTemplateId, imported, formData.contextModelId, listedInitial, fetchedInitial.data,
        dsSchemaLoading, updateFormData, libraryTemplateUpdate, onInitialTemplateApplied,
    ])

    // Started from the workspace's default: one click back to an empty canvas.
    const startedFromDefault = !!workspaceDefault && formData.contextModelId === workspaceDefault.templateId
    const startEmpty = useCallback(() => {
        updateFormData({
            layers: [], assignments: {}, layoutTemplateId: undefined,
            contextModelId: undefined, contextModelVersion: undefined, suggestedFills: undefined, entityScope: undefined,
        })
    }, [updateFormData])

    // The template this view started from, named where the layers are edited.
    const appliedTemplate = formData.contextModelId
        ? library.find(t => t.id === formData.contextModelId)
            ?? (fetchedInitial.data?.id === formData.contextModelId ? fetchedInitial.data : undefined)
        : undefined

    // What the graph could fill each open layer with, read from the layers as they
    // are now — the applied template's own hints included, as applying dropped the
    // ones this data lacks. Never a layer entities were placed in by hand.
    const offers = useMemo(() => {
        const hintsOf = (layer: ViewLayerConfig) =>
            appliedTemplate?.layers.find(t => t.id === layer.templateLayerId)?.entityTypes ?? []
        const open = new Set(formData.layers.filter(l => !placedOtherwise(l, formData.assignments)).map(l => l.id))
        return Object.fromEntries(Object.entries(suggestFills(formData.layers, fitTarget, hintsOf)).filter(([id]) => open.has(id)))
    }, [formData.layers, formData.assignments, fitTarget, appliedTemplate])
    /** The layers ticked in "Suggest from your graph"; null while it is closed. */
    const [reviewing, setReviewing] = useState<Set<string> | null>(null)

    /** Fill layers with what the graph suggests, each marked until kept or changed. */
    const takeOffers = useCallback((fills: Record<string, LayerFill>) => {
        if (Object.keys(fills).length === 0) return
        updateFormData({
            layers: formData.layers.map(l => (fills[l.id] ? { ...l, entityTypes: fills[l.id].types } : l)),
            suggestedFills: { ...formData.suggestedFills, ...fills },
            // Layers that place by type resolve only in open scope (see GalleryTemplate.entityScope).
            entityScope: formData.entityScope ?? 'all',
        })
    }, [formData.layers, formData.suggestedFills, formData.entityScope, updateFormData])

    /** The person keeps what the graph suggested for a layer: it is no longer a suggestion. */
    const handleKeepFill = useCallback((layerId: string) => {
        const rest = { ...formData.suggestedFills }
        delete rest[layerId]
        updateFormData({ suggestedFills: rest })
    }, [formData.suggestedFills, updateFormData])
    // ────────────────────────────────────────────────────────────────────────

    const handleSelectLayoutType = useCallback((type: 'graph' | 'hierarchy' | 'reference') => {
        updateFormData({ layoutType: type })
        // If switching to reference and no layers, start with empty
        if (type === 'reference' && formData.layers.length === 0) {
            // Don't auto-add—let user pick template
        }
    }, [updateFormData, formData.layers])

    const handleAddLayer = useCallback(() => {
        const newLayer: ViewLayerConfig = {
            id: generateId(),
            name: `Layer ${formData.layers.length + 1}`,
            description: '',
            color: LAYER_COLORS[formData.layers.length % LAYER_COLORS.length],
            entityTypes: [],
            order: formData.layers.length
        }
        updateFormData({ layers: [...formData.layers, newLayer] })
        setExpandedLayerId(newLayer.id)
    }, [formData.layers, updateFormData])

    const handleUpdateLayer = useCallback((id: string, updates: Partial<ViewLayerConfig>) => {
        updateFormData({
            layers: formData.layers.map(l => l.id === id ? { ...l, ...updates } : l)
        })
    }, [formData.layers, updateFormData])

    const handleRemoveLayer = useCallback((id: string) => {
        updateFormData({
            layers: formData.layers.filter(l => l.id !== id)
        })
        if (expandedLayerId === id) setExpandedLayerId(null)
    }, [formData.layers, expandedLayerId, updateFormData])

    const handleReorderLayers = useCallback((reordered: ViewLayerConfig[]) => {
        updateFormData({
            layers: reordered.map((l, i) => ({ ...l, order: i }))
        })
    }, [updateFormData])

    // What the reference-layout section renders:
    //  - gallery open (either flow) → the shared Quick Start gallery
    //  - blank + empty template chosen → an add-your-own prompt
    //  - otherwise (layers exist) → the layer editor
    const showBlankEmptyState = blank && !showGallery && formData.layers.length === 0
    const showLayerList = formData.layers.length > 0 && !showGallery

    // The suggestions with choices on them: which root types make layers, and
    // which entities become columns.
    const suggestionsLoading = !blank && (dsSchemaLoading || topLevel.isLoading)
    const perTypeCard = rootTypeCandidates.length > 0 && (
        <PerTypeCard
            key={`type:${rootTypeIds.join('|')}`}
            candidates={rootTypeCandidates}
            options={rootTypeCandidates.map(c => {
                const of = entityTypesTop.find(t => t.id === c.typeId)
                return { id: c.typeId, name: typesByFold.get(caseFold(c.typeId))?.name ?? c.typeId, count: of?.count, over: of?.over }
            })}
            // On a blank model "From your ontology" stays the recommended start.
            recommended={!blank && !entityColumnsFirst}
            active={formData.layoutTemplateId === 'per-root-type'}
            onCreate={chosen => handleApplyGalleryTemplate({
                id: 'per-root-type', name: 'One layer per top-level type', description: '',
                layers: layersForRootTypes(chosen), entityScope: 'all',
            })}
        />
    )
    const perEntityCard = firstEntityType && (
        <PerEntityCard
            key={`entity:${withEntities.map(t => t.id).join('|')}`}
            types={withEntities}
            initialType={firstEntityType.id}
            recommended={entityColumnsFirst}
            active={formData.layoutTemplateId === 'per-entity'}
            onCreate={entities => {
                // Each column IS its entity, placed by its own assignment: a closed
                // (curated) view of those entities and what they hold.
                const made = layersForTopLevelEntities(entities)
                handleApplyGalleryTemplate({
                    id: 'per-entity', name: 'One column per top-level entity', description: '',
                    layers: made.layers, entityScope: 'curated',
                }, made.assignments)
            }}
        />
    )

    return (
        <div className="space-y-8">
            {savingAsTemplate && (
                <SaveAsTemplateDialog
                    sourceName={formData.name.trim() || 'New view'}
                    description={formData.description}
                    layers={formData.layers}
                    onClose={() => setSavingAsTemplate(false)}
                />
            )}
            {/* Layout Type Selection */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-4"
            >
                <div className="text-center mb-6">
                    <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
                        Choose your layout type
                    </h3>
                    <p className="text-slate-500">
                        Select how you want your view to be organized
                    </p>
                </div>

                <div className="grid grid-cols-3 gap-4">
                    {layoutTypes.map((type) => (
                        <motion.button
                            key={type.id}
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => handleSelectLayoutType(type.id)}
                            className={cn(
                                'relative p-6 rounded-2xl border-2 text-left transition-colors duration-150',
                                formData.layoutType === type.id
                                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 ring-4 ring-blue-500/10'
                                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-800'
                            )}
                        >
                            {/* Recommended Badge */}
                            {type.recommended && (
                                <span className="absolute -top-2 -right-2 px-2 py-0.5 text-xs font-semibold bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-full shadow-lg">
                                    Recommended
                                </span>
                            )}

                            {/* Selected Check */}
                            {formData.layoutType === type.id && (
                                <motion.div
                                    initial={{ scale: 0 }}
                                    animate={{ scale: 1 }}
                                    className="absolute top-3 right-3 w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center"
                                >
                                    <Check className="w-4 h-4 text-white" />
                                </motion.div>
                            )}

                            <div className="text-blue-600 dark:text-blue-400 mb-3">
                                {type.icon}
                            </div>
                            <h4 className="font-bold text-slate-900 dark:text-white mb-1">
                                {type.label}
                            </h4>
                            <p className="text-sm text-slate-500 mb-3">
                                {type.description}
                            </p>
                            <ul className="space-y-1">
                                {type.features.map((feature, i) => (
                                    <li key={i} className="flex items-center gap-2 text-xs text-slate-400">
                                        <span className="w-1 h-1 rounded-full bg-slate-400" />
                                        {feature}
                                    </li>
                                ))}
                            </ul>
                        </motion.button>
                    ))}
                </div>
            </motion.div>

            {/* Layer Configuration (for Reference Model) */}
            <AnimatePresence>
                {formData.layoutType === 'reference' && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="space-y-4 pt-6 border-t border-slate-200 dark:border-slate-700"
                    >
                        <div className="flex items-center justify-between">
                            <div>
                                <h4 className="font-bold text-slate-900 dark:text-white">
                                    {showGallery ? 'Choose a starting template' : 'Configure Layers'}
                                </h4>
                                <p className="text-sm text-slate-500">
                                    {showGallery
                                        ? 'Pick a starting arrangement — you can refine the layers next'
                                        : appliedTemplate
                                            ? `Started from “${appliedTemplate.name}”. Refine its layers below.`
                                            : 'Define the horizontal layers for your context view'}
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                {showLayerList && fitTarget && (
                                    <button
                                        type="button"
                                        onClick={() => setReviewing(reviewing ? null : new Set(Object.keys(offers)))}
                                        aria-expanded={!!reviewing}
                                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors"
                                    >
                                        <Wand2 className="w-4 h-4" />
                                        Suggest from your graph
                                    </button>
                                )}
                                {templatesOn && !showGallery && formData.layers.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => setSavingAsTemplate(true)}
                                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                                    >
                                        <Save className="w-4 h-4" />
                                        Save as template
                                    </button>
                                )}
                                {!showGallery && !imported && (
                                    <button
                                        onClick={handleSwitchTemplate}
                                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                                    >
                                        <Repeat className="w-4 h-4" />
                                        Switch template
                                    </button>
                                )}
                                {/* Existing-source mode keeps manual building available even
                                    while the gallery shows (its original behavior); blank mode
                                    requires an explicit template choice first. */}
                                {(!showGallery || !blank) && (
                                    <button
                                        onClick={handleAddLayer}
                                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                                    >
                                        <Plus className="w-4 h-4" />
                                        Add Layer
                                    </button>
                                )}
                            </div>
                        </div>

                        {imported && (
                            <div className="flex items-start gap-3 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50/50 dark:bg-indigo-950/20 px-4 py-3">
                                <Layers className="w-4 h-4 text-indigo-500 mt-0.5 shrink-0" />
                                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                                    <span className="font-semibold text-slate-800 dark:text-slate-100">These layers came from the file.</span>{' '}
                                    Rename, reorder or add layers freely; removing a layer also unplaces what was placed on it.
                                </p>
                            </div>
                        )}

                        {/* Quick Start: what the data suggests, then the template library —
                            shared by both creation flows */}
                        {showGallery && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="p-4 space-y-6 bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-xl border border-indigo-200 dark:border-indigo-800"
                            >
                                {(suggestedTemplates.length > 0 || rootTypeCandidates.length > 0 || (!blank && dsSchemaLoading)) && (
                                    <div>
                                        <div className="flex items-center gap-2 mb-3">
                                            <Wand2 className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                                            <span className="font-semibold text-slate-800 dark:text-slate-200">Suggested for your data</span>
                                        </div>
                                        <TemplateGallery
                                            templates={suggestedTemplates}
                                            activeId={formData.layoutTemplateId}
                                            loading={suggestionsLoading}
                                            onApply={template => handleApplyGalleryTemplate(template)}
                                            before={blank ? undefined : entityColumnsFirst ? <>{perEntityCard}{perTypeCard}</> : <>{perTypeCard}{perEntityCard}</>}
                                            after={blank ? perTypeCard : undefined}
                                        />
                                        {tooMany && !suggestionsLoading && (
                                            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                                                {tooMany.count != null ? tooMany.count.toLocaleString() : `More than ${ENTITY_COLUMNS_MAX}`} {tooMany.plural} are too many to read side by side, so a column for each isn't offered. One layer per top-level type keeps them in one column.
                                            </p>
                                        )}
                                    </div>
                                )}
                                {templatesOn && (
                                    <div>
                                        <div className="flex flex-wrap items-center gap-2 mb-3">
                                            <LayoutTemplate className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                                            <span className="font-semibold text-slate-800 dark:text-slate-200">Template library</span>
                                            <span className="text-xs text-slate-500">Yours, your teams' and your organization's</span>
                                            <div className="relative ml-auto">
                                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                                                <input
                                                    type="search"
                                                    value={libraryQuery}
                                                    onChange={e => setLibraryQuery(e.target.value)}
                                                    placeholder="Search templates"
                                                    aria-label="Search templates"
                                                    className="h-8 w-52 pl-8 pr-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                                                />
                                            </div>
                                        </div>
                                        {libraryTabs.length > 1 && (
                                            <div role="tablist" aria-label="Template collections" className="flex flex-wrap gap-1 mb-3">
                                                {libraryTabs.map(tab => (
                                                    <button
                                                        key={tab.id}
                                                        type="button"
                                                        role="tab"
                                                        aria-selected={libraryTab === tab.id}
                                                        onClick={() => setLibraryTab(tab.id)}
                                                        className={cn(
                                                            'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                                                            libraryTab === tab.id
                                                                ? 'bg-indigo-600 text-white'
                                                                : 'text-slate-600 dark:text-slate-300 hover:bg-white/70 dark:hover:bg-slate-800',
                                                        )}
                                                    >
                                                        {tab.label}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                        <TemplateGallery
                                            templates={libraryTemplates}
                                            activeId={formData.layoutTemplateId}
                                            loading={libraryLoading || (!blank && dsSchemaLoading)}
                                            onApply={item => {
                                                const template = library.find(t => t.id === item.id)
                                                if (template) handleApplyLibraryTemplate(template)
                                            }}
                                        />
                                        {!libraryLoading && !(!blank && dsSchemaLoading) && libraryTemplates.length === 0 && (
                                            <p className="text-xs text-slate-500 py-2">
                                                {libraryQuery ? `No template matches "${libraryQuery}".` : 'No templates in this collection yet.'}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </motion.div>
                        )}

                        {startedFromDefault && showLayerList && (
                            <div role="status" className="flex items-center gap-3 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/20 px-4 py-2.5">
                                <Home className="w-4 h-4 text-emerald-600 shrink-0" />
                                <p className="text-xs text-slate-600 dark:text-slate-300 flex-1">
                                    New views in <span className="font-semibold text-slate-800 dark:text-slate-100">{workspaceDefault!.workspaceName}</span> start from this layout.
                                </p>
                                <button type="button" onClick={startEmpty} className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline">
                                    Start empty instead
                                </button>
                            </div>
                        )}

                        {reviewing && showLayerList && (
                            <SuggestionReview
                                layers={formData.layers}
                                offers={offers}
                                ticked={reviewing}
                                typesByFold={typesByFold}
                                onToggle={id => setReviewing(prev => {
                                    const next = new Set(prev)
                                    if (!next.delete(id)) next.add(id)
                                    return next
                                })}
                                onApply={() => {
                                    takeOffers(Object.fromEntries(Object.entries(offers).filter(([id]) => reviewing.has(id))))
                                    setReviewing(null)
                                }}
                                onClose={() => setReviewing(null)}
                            />
                        )}

                        {/* Blank models: empty template chosen — prompt to build layers */}
                        {showBlankEmptyState && (
                            <div className="flex flex-col items-center justify-center py-10 text-center rounded-xl border border-dashed border-slate-200 dark:border-slate-700">
                                <p className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Starting from an empty canvas</p>
                                <p className="text-xs text-slate-400 max-w-[280px]">
                                    Add layers to organize your model, or switch to a template above.
                                </p>
                            </div>
                        )}

                        {/* Layer List */}
                        {showLayerList && (
                            <Reorder.Group
                                axis="y"
                                values={formData.layers}
                                onReorder={handleReorderLayers}
                                className="space-y-2"
                            >
                                {formData.layers.map((layer, index) => (
                                    <Reorder.Item
                                        key={layer.id}
                                        value={layer}
                                        className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden"
                                    >
                                        {/* Layer Header */}
                                        <div
                                            className="flex items-center gap-3 p-4 cursor-pointer"
                                            onClick={() => setExpandedLayerId(expandedLayerId === layer.id ? null : layer.id)}
                                        >
                                            <GripVertical className="w-5 h-5 text-slate-400 cursor-grab" />
                                            <div
                                                className="w-4 h-4 rounded-full"
                                                style={{ backgroundColor: layer.color }}
                                            />
                                            <span className="font-medium text-slate-800 dark:text-slate-200 flex-1">
                                                {layer.name}
                                            </span>
                                            <span className="text-xs text-slate-400 px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded-full">
                                                Order: {index + 1}
                                            </span>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleRemoveLayer(layer.id) }}
                                                className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                            {expandedLayerId === layer.id ? (
                                                <ChevronDown className="w-5 h-5 text-slate-400" />
                                            ) : (
                                                <ChevronRight className="w-5 h-5 text-slate-400" />
                                            )}
                                        </div>
                                        <LayerFillRow
                                            layer={layer}
                                            suggestion={formData.suggestedFills?.[layer.id]}
                                            typesByFold={typesByFold}
                                            placed={placedOtherwise(layer, formData.assignments)}
                                            canChoose={availableEntityTypes.length > 0}
                                            offer={offers[layer.id]}
                                            onKeep={() => handleKeepFill(layer.id)}
                                            onChoose={() => setExpandedLayerId(layer.id)}
                                            onTakeOffer={() => takeOffers({ [layer.id]: offers[layer.id] })}
                                        />

                                        {/* Expanded Content */}
                                        <AnimatePresence>
                                            {expandedLayerId === layer.id && (
                                                <motion.div
                                                    initial={{ height: 0 }}
                                                    animate={{ height: 'auto' }}
                                                    exit={{ height: 0 }}
                                                    className="overflow-hidden"
                                                >
                                                    <div className="p-4 pt-0 space-y-4 border-t border-slate-100 dark:border-slate-700">
                                                        <div className="grid grid-cols-2 gap-4">
                                                            <div>
                                                                <label className="text-xs font-medium text-slate-500 uppercase">Name</label>
                                                                <input
                                                                    type="text"
                                                                    value={layer.name}
                                                                    onChange={(e) => handleUpdateLayer(layer.id, { name: e.target.value })}
                                                                    className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
                                                                />
                                                            </div>
                                                            <div>
                                                                <label className="text-xs font-medium text-slate-500 uppercase">Color</label>
                                                                <div className="flex gap-2 mt-1">
                                                                    {LAYER_COLORS.map(color => (
                                                                        <button
                                                                            key={color}
                                                                            onClick={() => handleUpdateLayer(layer.id, { color })}
                                                                            className={cn(
                                                                                'w-7 h-7 rounded-full transition-transform',
                                                                                layer.color === color && 'ring-2 ring-offset-2 ring-blue-500 scale-110'
                                                                            )}
                                                                            style={{ backgroundColor: color }}
                                                                        />
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div>
                                                            <label className="text-xs font-medium text-slate-500 uppercase">Description</label>
                                                            <input
                                                                type="text"
                                                                value={layer.description || ''}
                                                                onChange={(e) => handleUpdateLayer(layer.id, { description: e.target.value })}
                                                                placeholder="Optional description"
                                                                className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="text-xs font-medium text-slate-500 uppercase">Entity Types</label>
                                                            <div className="flex flex-wrap gap-1.5 mt-1 min-h-[32px]">
                                                                {availableEntityTypes.map(et => {
                                                                    const active = (layer.entityTypes ?? []).includes(et.id)
                                                                    return (
                                                                        <button
                                                                            key={et.id}
                                                                            type="button"
                                                                            onClick={() => handleUpdateLayer(layer.id, {
                                                                                entityTypes: active
                                                                                    ? (layer.entityTypes ?? []).filter(id => id !== et.id)
                                                                                    : [...(layer.entityTypes ?? []), et.id]
                                                                            })}
                                                                            className={cn(
                                                                                'px-2 py-1 text-xs rounded-full border transition-colors',
                                                                                active
                                                                                    ? 'border-transparent text-white'
                                                                                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                                                                            )}
                                                                            style={active ? { backgroundColor: et.visual.color } : undefined}
                                                                        >
                                                                            {et.name}
                                                                        </button>
                                                                    )
                                                                })}
                                                                {availableEntityTypes.length === 0 && (
                                                                    <span className="text-xs text-slate-400 italic">No entity types in ontology yet</span>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </motion.div>
                                            )}
                                        </AnimatePresence>
                                    </Reorder.Item>
                                ))}
                            </Reorder.Group>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

export default LayoutStep
