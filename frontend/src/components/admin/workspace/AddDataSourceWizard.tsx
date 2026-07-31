/**
 * AddDataSourceWizard — attaching data to a workspace, on the premium shell.
 *
 * It replaces an AdminWizard whose entire first step was one native `<select>`
 * ("Select a data source…") and whose second was a `<dl>`. Three things that
 * dropdown could not do, and this must:
 *
 *   • Show which PROVIDER an item comes from. Every option looked the same, so
 *     picking between "prod" and "prod" was guesswork.
 *   • Explain absence. Items already attached to another workspace were silently
 *     filtered out of the list, so a source you knew existed simply wasn't there.
 *     They're now shown, disabled, saying who has them.
 *   • Say what a semantic layer DOES. "None (use system defaults)" was the first
 *     option of a second dropdown, with no hint that the choice decides how your
 *     entities get classified.
 */
import { useState, useMemo, useCallback, useEffect, startTransition } from 'react'
import { motion } from 'framer-motion'
import {
    Database, BookOpen, ClipboardCheck, Check, Loader2, AlertTriangle, Sparkles, MoveRight,
    ChevronDown, ChevronLeft, ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { WizardShell, type WizardStepDef } from '@/components/wizard/WizardShell'
import { CatalogItemPicker, isMovable, type PickableCatalogItem } from '@/components/wizard/CatalogItemPicker'
import { useOntologyMatches } from '@/components/wizard/useOntologyMatches'
// The same coverage visuals the onboarding wizard uses — one look, one meaning.
import {
    CoverageRing, MiniBar, coverageColor, coverageBarClass,
} from '@/components/admin/AssetOnboardingWizard/steps/CoverageVisuals'
import type { OntologyMatchResult } from '@/services/ontologyDefinitionService'
import { useQuery } from '@tanstack/react-query'
import { workspaceService } from '@/services/workspaceService'
import { NodeIdentityField, isIdentityOverridden, isNameOverridden } from '@/components/dataSource/NodeIdentity'
import { PropertyMappingForm } from '@/components/admin/shared/PropertyMappingForm'
import {
    DEFAULT_PROPERTY_MAPPING,
    savePropertyMapping,
    type PropertyMapping,
} from '@/services/propertyStorageService'

/** Persist the mapping only when the operator actually changed it, and never
 *  let that failure lose them the source they just attached. */
async function _saveMappingIfCustomised(
    wsId: string, dsId: string | undefined, mapping: PropertyMapping,
): Promise<void> {
    if (!dsId) return
    const unchanged =
        mapping.containerKey === DEFAULT_PROPERTY_MAPPING.containerKey
        && mapping.separator === DEFAULT_PROPERTY_MAPPING.separator
        && mapping.collectUnmapped === DEFAULT_PROPERTY_MAPPING.collectUnmapped
        && Object.keys(mapping.propertyOverrides).length === 0
    if (unchanged) return
    try {
        await savePropertyMapping(wsId, dsId, mapping)
    } catch {
        // The source is attached and usable; the mapping is editable from its
        // Mapping tab. Failing the whole wizard here would be worse.
    }
}
import { catalogService } from '@/services/catalogService'
import type { ProviderResponse } from '@/services/providerService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

const STEPS: WizardStepDef[] = [
    { id: 'source', label: 'Source', icon: <Database className="w-6 h-6" /> },
    { id: 'semantics', label: 'Semantics', icon: <BookOpen className="w-6 h-6" /> },
    { id: 'review', label: 'Review', icon: <ClipboardCheck className="w-6 h-6" /> },
]

export function AddDataSourceWizard({
    isOpen,
    workspaceId,
    workspaceName,
    onClose,
    onAdded,
    catalogItems,
    providers,
    ontologies,
}: {
    isOpen: boolean
    workspaceId: string
    workspaceName?: string
    onClose: () => void
    onAdded: () => void
    catalogItems: PickableCatalogItem[]
    providers: ProviderResponse[]
    ontologies: OntologyDefinitionResponse[]
}) {
    const [step, setStep] = useState<string>('source')
    const [catalogItemId, setCatalogItemId] = useState('')
    const [label, setLabel] = useState('')
    const [ontologyId, setOntologyId] = useState('')
    const [identityProperty, setIdentityProperty] = useState('')
    const [nameProperty, setNameProperty] = useState('')
    // Property mapping is saved AFTER the source exists, through the same
    // narrow endpoint the Mapping tab uses — the create request has no
    // extraConfig, and giving it one would put the client back in the
    // business of round-tripping a blob whose secrets come back redacted.
    const [propertyMapping, setPropertyMapping] =
        useState<PropertyMapping>(DEFAULT_PROPERTY_MAPPING)

    const [phase, setPhase] = useState<'steps' | 'adding' | 'success'>('steps')
    const [error, setError] = useState<string | null>(null)

    // OWNERSHIP, not permission. The page's catalog list is filtered by
    // `permittedWorkspaces` — who MAY use an item — which says nothing about who
    // HAS it. That is why already-owned sources were offered as selectable and the
    // POST died on the unique constraint. Bindings are the only thing that knows.
    const bindingsQuery = useQuery({
        queryKey: ['catalog', 'bindings'],
        queryFn: () => catalogService.listWithBindings(),
        enabled: isOpen,
        staleTime: 30_000,
    })

    // Bindings ARE the catalog, plus who owns each item, which data source row owns
    // it, and how many views are built on it. An earlier version merged only
    // boundWorkspaceId/Name onto the page's list and dropped boundDataSourceId and
    // boundViewCount — the exact two fields isMovable() needs — so nothing was ever
    // offered as movable.
    const items: PickableCatalogItem[] = bindingsQuery.data ?? catalogItems

    const selected = items.find(c => c.id === catalogItemId)
    const chosenOntology = ontologies.find(o => o.id === ontologyId)

    // Picking a source that ALREADY belongs to another workspace is a MOVE, not an
    // attach. It only appears when nothing is built on it — the server refuses the
    // rest with a 409.
    const isMove = Boolean(selected && isMovable(selected, workspaceId))

    // Score every semantic layer against THIS graph. Without it the step asks the
    // user to choose between eight cards all called "Roots-node".
    const matching = useOntologyMatches({
        providerId: selected?.providerId,
        // The graph as the provider knows it — the label is a workspace-local alias.
        assetName: selected?.sourceIdentifier || selected?.name,
        enabled: step === 'semantics' && !!selected,
    })

    const scoreOf = useMemo(() => {
        const map = new Map<string, OntologyMatchResult>()
        for (const m of matching.matches) map.set(m.ontologyId, m)
        return map
    }, [matching.matches])

    // Rank the cards by fit, not by creation order.
    const rankedOntologies = useMemo(() => {
        return [...ontologies].sort((a, b) => {
            const sa = scoreOf.get(a.id)?.jaccardScore ?? -1
            const sb = scoreOf.get(b.id)?.jaccardScore ?? -1
            return sb - sa
        })
    }, [ontologies, scoreOf])

    // Three is the answer, not a list. Dumping thirteen layers — ten of which don't
    // fit — makes the user do the ranking we just did for them. The rest stay one
    // click away, paginated, and carry the SAME numbers and warnings: a layer is
    // only fairly rejected if you can see why.
    const TOP_N = 3
    const PAGE_SIZE = 4
    const [showAll, setShowAll] = useState(false)
    const [page, setPage] = useState(0)

    const topMatches = rankedOntologies.slice(0, TOP_N)
    const restMatches = rankedOntologies.slice(TOP_N)
    const pageCount = Math.max(1, Math.ceil(restMatches.length / PAGE_SIZE))
    const pagedRest = restMatches.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

    // A layer chosen from deep in the list must stay visible when the list collapses.
    const selectedIsHidden = Boolean(
        ontologyId && !showAll && restMatches.some(o => o.id === ontologyId),
    )

    // Asking for every layer (min_score=0) means "best" exists even when NOTHING
    // fits. A 0% layer must never wear a BEST FIT badge or get auto-selected — that
    // would be a worse lie than the flat list this replaced.
    const bestId = (matching.best?.jaccardScore ?? 0) > 0
        ? matching.best?.ontologyId ?? null
        : null

    // Pre-select the best fit once, and only if the user hasn't chosen — a
    // recommendation, not a hijack.
    const [pickedOntology, setPickedOntology] = useState(false)
    useEffect(() => {
        if (matching.phase === 'ready' && bestId && !pickedOntology && ontologyId === '') {
            setOntologyId(bestId)
        }
    }, [matching.phase, bestId, pickedOntology, ontologyId])

    const stepIndex = STEPS.findIndex(s => s.id === step)
    const isLastStep = stepIndex === STEPS.length - 1

    // A data source is the whole point of this wizard — unlike Create Workspace,
    // you cannot skip it. Next stays dead until one is picked.
    const canProceed = useMemo(() => {
        if (step === 'source') return catalogItemId !== ''
        return true
    }, [step, catalogItemId])

    const warning = step === 'source' && !catalogItemId
        ? 'Choose a data source to continue.'
        : null

    const reset = useCallback(() => {
        setStep('source'); setCatalogItemId(''); setLabel(''); setOntologyId(''); setIdentityProperty('')
        setPhase('steps'); setError(null); setPickedOntology(false)
    }, [])

    const handleClose = useCallback(() => {
        if (phase === 'adding') return
        reset()
        onClose()
    }, [phase, reset, onClose])

    const handleSubmit = useCallback(async () => {
        setPhase('adding')
        setError(null)
        try {
            if (isMove && selected?.boundWorkspaceId && selected.boundDataSourceId) {
                // Move keeps the SAME data source row, so its stats, polling config
                // and aggregation state travel with it.
                await workspaceService.moveDataSource(
                    selected.boundWorkspaceId,
                    selected.boundDataSourceId,
                    workspaceId,
                )
                // Label/ontology are per-data-source and survive the move; apply any
                // change the user made here on top.
                if (label.trim() || ontologyId || isIdentityOverridden(identityProperty) || isNameOverridden(nameProperty)) {
                    await workspaceService.updateDataSource(workspaceId, selected.boundDataSourceId, {
                        label: label.trim() || undefined,
                        ontologyId: ontologyId || undefined,
                        identityProperty: identityProperty || undefined,
                        nameProperty: nameProperty || undefined,
                    })
                }
                await _saveMappingIfCustomised(
                    workspaceId, selected.boundDataSourceId, propertyMapping,
                )
            } else {
                const created = await workspaceService.addDataSource(workspaceId, {
                    catalogItemId,
                    label: label.trim() || undefined,
                    ontologyId: ontologyId || undefined,
                    identityProperty: identityProperty || undefined,
                    nameProperty: nameProperty || undefined,
                })
                await _saveMappingIfCustomised(
                    workspaceId, created?.id, propertyMapping,
                )
            }
            setPhase('success')
        } catch (err) {
            setError(err instanceof Error
                ? err.message
                : isMove ? 'Could not move the data source.' : 'Could not attach the data source.')
            setPhase('steps')
            setStep('review')
        }
    }, [workspaceId, catalogItemId, label, ontologyId, identityProperty, nameProperty, isMove, selected])

    if (!isOpen) return null

    const terminalPhase = phase === 'steps'
        ? undefined
        : phase === 'adding' ? 'creating' as const : 'success' as const

    return (
        <WizardShell
            title={isMove ? 'Move Data Source' : 'Add Data Source'}
            submitLabel={isMove ? 'Move it here' : 'Add data source'}
            currentStep={step}
            activeSteps={STEPS}
            currentStepIndex={stepIndex < 0 ? 0 : stepIndex}
            onStepClick={id => startTransition(() => setStep(id))}
            onBack={() => startTransition(() => setStep(STEPS[Math.max(stepIndex - 1, 0)].id))}
            onNext={() => startTransition(() => setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)].id))}
            onClose={handleClose}
            canProceed={canProceed}
            isLastStep={isLastStep}
            isSubmitting={phase === 'adding'}
            onSubmit={handleSubmit}
            terminalPhase={terminalPhase}
            terminalLabel={phase === 'success' ? (isMove ? 'Moved' : 'Added') : (isMove ? 'Moving' : 'Adding')}
            terminalSubtitle={
                phase === 'success'
                    ? `${selected?.name} is ${isMove ? 'here' : 'attached'}`
                    : isMove ? 'Moving the data source…' : 'Attaching the data source…'
            }
            hideClose={phase === 'adding'}
            wide={step === 'source'}
            helpSlug="admin-setup"
            footer={
                phase === 'success' ? (
                    <div className="flex items-center justify-end w-full">
                        <button
                            onClick={() => { reset(); onClose(); onAdded() }}
                            className="flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-md hover:from-emerald-700 hover:to-teal-700 transition-colors"
                        >
                            <Check className="w-4 h-4" />
                            Done
                        </button>
                    </div>
                ) : phase === 'adding' ? (
                    <div className="flex items-center gap-2 text-slate-500 w-full justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-sm">Attaching…</span>
                    </div>
                ) : undefined
            }
        >
            {phase === 'adding' && (
                <div className="flex flex-col items-center justify-center py-16 gap-4">
                    <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
                    <p className="text-sm text-slate-500">
                        {isMove ? 'Moving' : 'Attaching'} “{selected?.name}”…
                    </p>
                </div>
            )}

            {phase === 'success' && (
                <div className="flex flex-col items-center justify-center py-14 gap-5 text-center">
                    <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', damping: 12, stiffness: 220 }}
                        className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/25"
                    >
                        <Check className="w-8 h-8 text-white" />
                    </motion.div>
                    <div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white">
                            “{selected?.name}” is {isMove ? 'here' : 'attached'}
                        </h3>
                        <p className="text-sm text-slate-500 mt-1">
                            {isMove
                                ? 'It kept its aggregation state and stats. Build a view on it whenever you like.'
                                : "Run aggregation when you're ready, then build a view on it."}
                        </p>
                    </div>
                </div>
            )}

            {phase === 'steps' && step === 'source' && (
                <div className="space-y-5">
                    <StepHeader
                        icon={<Database className="w-5 h-5" />}
                        title="Which data source?"
                        subtitle={workspaceName
                            ? `It will be attached to ${workspaceName}.`
                            : 'Pick the catalog item to attach to this workspace.'}
                    />
                    <CatalogItemPicker
                        items={items}
                        providers={providers}
                        selectedId={catalogItemId}
                        onSelect={setCatalogItemId}
                        currentWorkspaceId={workspaceId}
                        allowMove
                    />
                    {catalogItemId && (
                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                                Label <span className="text-slate-400 font-normal">(optional)</span>
                            </label>
                            <input
                                value={label}
                                onChange={e => setLabel(e.target.value)}
                                placeholder={selected?.name ?? 'e.g. Main Graph'}
                                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                            />
                        </div>
                    )}
                </div>
            )}

            {phase === 'steps' && step === 'semantics' && (
                <div className="space-y-5">
                    <StepHeader
                        icon={<BookOpen className="w-5 h-5" />}
                        title="How should this data be classified?"
                        subtitle="A semantic layer decides which entity and relationship types this source's data maps onto. You can change it later."
                    />

                    {/* Profiling the graph. The list is unreadable without it — eight
                        of these layers share a name. */}
                    {matching.phase === 'analyzing' && (
                        <div className="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3">
                            <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
                            <p className="text-sm text-slate-600 dark:text-slate-400">
                                Matching “{selected?.name}” against your semantic layers…
                            </p>
                        </div>
                    )}

                    {matching.phase === 'error' && (
                        <div className="flex items-start gap-2 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
                            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                            <div className="min-w-0 flex-1">
                                <p className="text-xs text-amber-800 dark:text-amber-300">{matching.error}</p>
                                <p className="text-[11px] text-amber-700/80 dark:text-amber-400/80 mt-1">
                                    You can still choose a layer by hand — it just won't be scored.
                                </p>
                            </div>
                            {matching.retriable && (
                                <button
                                    type="button"
                                    onClick={matching.analyze}
                                    className="shrink-0 text-xs font-bold text-amber-700 dark:text-amber-400 hover:underline"
                                >
                                    Retry
                                </button>
                            )}
                        </div>
                    )}

                    {matching.phase === 'ready' && (
                        <div className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-4 py-2.5">
                            <Sparkles className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                            {/* The denominator behind every percentage below. */}
                            <p className="text-xs text-slate-600 dark:text-slate-400">
                                This graph has <span className="font-bold text-slate-900 dark:text-white">{matching.graphCounts.entities}</span> entity
                                {' '}type{matching.graphCounts.entities === 1 ? '' : 's'} and
                                {' '}<span className="font-bold text-slate-900 dark:text-white">{matching.graphCounts.rels}</span> relationship
                                {' '}type{matching.graphCounts.rels === 1 ? '' : 's'}. Layers are ranked by how much of it they cover.
                            </p>
                        </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <OntologyCard
                            selected={ontologyId === ''}
                            onClick={() => { setPickedOntology(true); setOntologyId('') }}
                            title="System defaults"
                            subtitle="Classify with the built-in types"
                            meta="Use this if nothing fits"
                            dashed
                        />

                        {topMatches.map(o => (
                            <OntologyCardFor
                                key={o.id}
                                ontology={o}
                                match={scoreOf.get(o.id)}
                                selected={ontologyId === o.id}
                                isBest={bestId === o.id && matching.phase === 'ready'}
                                analysed={matching.phase === 'ready'}
                                onPick={() => { setPickedOntology(true); setOntologyId(o.id) }}
                            />
                        ))}

                        {/* Chosen from the long list, then collapsed — keep it on screen
                            rather than making the selection vanish. */}
                        {selectedIsHidden && (() => {
                            const o = restMatches.find(x => x.id === ontologyId)!
                            return (
                                <OntologyCardFor
                                    ontology={o}
                                    match={scoreOf.get(o.id)}
                                    selected
                                    analysed={matching.phase === 'ready'}
                                    onPick={() => { setPickedOntology(true); setOntologyId(o.id) }}
                                />
                            )
                        })()}

                        {showAll && pagedRest.map(o => (
                            <OntologyCardFor
                                key={o.id}
                                ontology={o}
                                match={scoreOf.get(o.id)}
                                selected={ontologyId === o.id}
                                analysed={matching.phase === 'ready'}
                                onPick={() => { setPickedOntology(true); setOntologyId(o.id) }}
                            />
                        ))}
                    </div>

                    {restMatches.length > 0 && (
                        <div className="flex items-center justify-between gap-3">
                            <button
                                type="button"
                                onClick={() => { setShowAll(v => !v); setPage(0) }}
                                className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                            >
                                <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', showAll && 'rotate-180')} />
                                {showAll
                                    ? 'Show only the top matches'
                                    : `Show all ${rankedOntologies.length} semantic layers`}
                            </button>

                            {showAll && pageCount > 1 && (
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        disabled={page === 0}
                                        onClick={() => setPage(p => Math.max(0, p - 1))}
                                        className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                    >
                                        <ChevronLeft className="w-4 h-4" />
                                    </button>
                                    <span className="text-xs text-slate-500 tabular-nums px-1">
                                        {page + 1} / {pageCount}
                                    </span>
                                    <button
                                        type="button"
                                        disabled={page >= pageCount - 1}
                                        onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                                        className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                    >
                                        <ChevronRight className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    {/* Node Identity Property (URN-equivalent) for the attached source. */}
                    <NodeIdentityField
                        variant="compact"
                        value={identityProperty}
                        onChange={setIdentityProperty}
                        providerId={selected?.providerId}
                        graphName={selected?.sourceIdentifier || selected?.name}
                        nameValue={nameProperty}
                        onNameChange={setNameProperty}
                    />

                    {/* Where this source keeps its properties. Set at attach
                        time so the first read is already correct — otherwise
                        the drawer shows an empty bag until someone notices.
                        No detected keys or collisions to offer yet: the graph
                        isn't attached, so there is nothing to sample. */}
                    <details className="group">
                        <summary className="cursor-pointer text-[11px] font-semibold text-ink-muted hover:text-ink transition-colors select-none">
                            Property mapping
                            <span className="ml-1.5 font-normal text-ink-muted/70">
                                — only if this source nests its properties
                            </span>
                        </summary>
                        <div className="mt-3 pl-3 border-l border-glass-border">
                            <PropertyMappingForm
                                value={propertyMapping}
                                onChange={setPropertyMapping}
                            />
                        </div>
                    </details>
                </div>
            )}

            {phase === 'steps' && step === 'review' && (
                <div className="space-y-5">
                    <StepHeader
                        icon={<ClipboardCheck className="w-5 h-5" />}
                        title={isMove ? 'Ready to move' : 'Ready to attach'}
                        subtitle={isMove
                            ? `It will leave ${selected?.boundWorkspaceName ?? 'its current workspace'} and live here instead.`
                            : 'Nothing is aggregated yet — you choose when to run that.'}
                    />

                    {isMove && (
                        <div className="flex items-start gap-2 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
                            <MoveRight className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                            <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                                <span className="font-semibold">This moves the source out of {selected?.boundWorkspaceName ?? 'another workspace'}.</span>{' '}
                                Nothing is built on it, so nothing breaks — its aggregation state and
                                stats come with it. Members of {selected?.boundWorkspaceName ?? 'that workspace'} will
                                no longer see it.
                            </p>
                        </div>
                    )}

                    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700 overflow-hidden">
                        <ReviewRow label="Data source" value={selected?.name ?? '—'} hint={selected?.sourceIdentifier} />
                        {isMove && (
                            <ReviewRow
                                label="Moving from"
                                value={selected?.boundWorkspaceName ?? 'Another workspace'}
                                hint="Nothing is built on it"
                            />
                        )}
                        <ReviewRow label="Label" value={label.trim() || selected?.name || '—'} />
                        <ReviewRow
                            label="Semantic layer"
                            value={chosenOntology?.name ?? 'System defaults'}
                            hint={(() => {
                                if (!chosenOntology) return 'Built-in entity + relationship types'
                                const m = scoreOf.get(chosenOntology.id)
                                if (!m) return `v${chosenOntology.version}`
                                const covered = m.coveredEntityTypes.length + m.coveredRelationshipTypes.length
                                const total = covered
                                    + m.uncoveredEntityTypes.length
                                    + m.uncoveredRelationshipTypes.length
                                const pct = total > 0 ? Math.round((covered / total) * 100) : 0
                                // Carry the number into the summary — a choice made on a
                                // score should still show it when you confirm.
                                return `v${chosenOntology.version} · covers ${pct}% of this graph's types`
                            })()}
                        />
                    </div>

                    {error && (
                        <div className="flex items-start gap-2 rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-4 py-3">
                            <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
                        </div>
                    )}
                </div>
            )}

            {phase === 'steps' && warning && (
                <div className="mt-5 flex items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                    <p className="text-xs text-amber-700 dark:text-amber-300">{warning}</p>
                </div>
            )}
        </WizardShell>
    )
}

function StepHeader({ icon, title, subtitle }: {
    icon: React.ReactNode
    title: string
    subtitle: string
}) {
    return (
        <div className="flex items-start gap-3">
            <span className="w-10 h-10 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center shrink-0">
                {icon}
            </span>
            <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">{title}</h3>
                <p className="text-sm text-slate-500">{subtitle}</p>
            </div>
        </div>
    )
}

function ReviewRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="flex items-baseline gap-4 px-4 py-3">
            <span className="w-28 shrink-0 text-xs font-medium text-slate-500">{label}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-slate-900 dark:text-white truncate">{value}</span>
                {hint && <span className="block text-xs text-slate-400 truncate">{hint}</span>}
            </span>
        </div>
    )
}

/**
 * One place that turns an ontology + its match into a card.
 *
 * The top three and the expanded list render through this, so a layer cannot show
 * a coverage ring in one place and a bare name in the other. That equivalence is
 * the point: a layer is only fairly rejected if you can see the same numbers and
 * warnings that got the winners to the top.
 */
function OntologyCardFor({ ontology, match, selected, isBest, analysed, onPick }: {
    ontology: OntologyDefinitionResponse
    match?: OntologyMatchResult
    selected: boolean
    isBest?: boolean
    analysed: boolean
    onPick: () => void
}) {
    return (
        <OntologyCard
            selected={selected}
            onClick={onPick}
            title={ontology.name}
            subtitle={ontology.description || `Version ${ontology.version}`}
            meta={`${Object.keys(ontology.entityTypeDefinitions ?? {}).length} entity types · ${Object.keys(ontology.relationshipTypeDefinitions ?? {}).length} relationships`}
            published={ontology.isPublished}
            // A zero-overlap layer scores 0 and covers nothing: showing it an empty
            // ring and a "doesn't cover: <everything>" list is noise. It reads as
            // what it is.
            match={match && match.jaccardScore > 0 ? match : undefined}
            isBest={isBest}
            noOverlap={analysed && (!match || match.jaccardScore === 0)}
        />
    )
}

function OntologyCard({ selected, onClick, title, subtitle, meta, published, dashed, match, isBest, noOverlap }: {
    selected: boolean
    onClick: () => void
    title: string
    subtitle: string
    meta: string
    published?: boolean
    dashed?: boolean
    /** Absent until the graph has been profiled — the card degrades to plain. */
    match?: OntologyMatchResult
    isBest?: boolean
    /** Analysed, and it doesn't overlap this graph (the server drops <10%). */
    noOverlap?: boolean
}) {
    // The SAME percentage the onboarding wizard shows: how much of the graph's
    // vocabulary — entity types AND relationship types — this layer accounts for.
    // Jaccard is what ranks them; coverage is what the human reads.
    const entityTotal = match
        ? match.coveredEntityTypes.length + match.uncoveredEntityTypes.length
        : 0
    const relTotal = match
        ? match.coveredRelationshipTypes.length + match.uncoveredRelationshipTypes.length
        : 0
    const totalAll = entityTotal + relTotal
    const totalCovered = match
        ? match.coveredEntityTypes.length + match.coveredRelationshipTypes.length
        : 0
    const pct = match && totalAll > 0 ? Math.round((totalCovered / totalAll) * 100) : 0
    return (
        <motion.button
            type="button"
            onClick={onClick}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
            className={cn(
                'relative flex flex-col gap-1 p-4 rounded-xl border-2 text-left transition-colors',
                dashed && 'border-dashed',
                selected
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 ring-4 ring-blue-500/10'
                    : 'border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700',
                // Still selectable — the score is advice, not a gate — but it stops
                // competing with the layers that actually fit.
                noOverlap && !selected && 'opacity-60',
            )}
        >
            <span className="flex items-start gap-3 min-w-0">
                {/* The score, where the eye lands first. Without it these cards are
                    eight identical names. */}
                {match && (
                    <CoverageRing percent={pct} size={44} stroke={4} color={coverageColor(pct)} />
                )}

                <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
                        {!match && (dashed
                            ? <Sparkles className="w-4 h-4 text-slate-400 shrink-0" />
                            : <BookOpen className="w-4 h-4 text-slate-400 shrink-0" />)}
                        <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">{title}</span>
                        {isBest && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400">
                                BEST FIT
                            </span>
                        )}
                        {published === false && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400">
                                DRAFT
                            </span>
                        )}
                    </span>

                    {match ? (
                        <span className="block mt-1.5 space-y-1">
                            <MiniBar
                                covered={match.coveredEntityTypes.length}
                                total={entityTotal}
                                label="Entity types"
                                colorClass={coverageBarClass(entityTotal > 0
                                    ? Math.round((match.coveredEntityTypes.length / entityTotal) * 100)
                                    : 0)}
                            />
                            <MiniBar
                                covered={match.coveredRelationshipTypes.length}
                                total={relTotal}
                                label="Relationships"
                                colorClass={coverageBarClass(relTotal > 0
                                    ? Math.round((match.coveredRelationshipTypes.length / relTotal) * 100)
                                    : 0)}
                            />
                            {/* What it MISSES. A 60% match sounds fine until you see
                                which of your types it can't name. */}
                            {match.uncoveredEntityTypes.length > 0 && (
                                <span className="block text-[10px] text-amber-600 dark:text-amber-400 truncate">
                                    Doesn't cover: {match.uncoveredEntityTypes.slice(0, 3).join(', ')}
                                    {match.uncoveredEntityTypes.length > 3 && ` +${match.uncoveredEntityTypes.length - 3}`}
                                </span>
                            )}
                        </span>
                    ) : (
                        <>
                            <span className="block text-xs text-slate-500 truncate">{subtitle}</span>
                            <span className="block text-[11px] text-slate-400 truncate">{meta}</span>
                            {noOverlap && (
                                <span className="block text-[10px] text-slate-400 mt-1">
                                    No overlap with this graph's types
                                </span>
                            )}
                        </>
                    )}
                </span>
            </span>

            {selected && (
                <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center"
                >
                    <Check className="w-3 h-3 text-white" />
                </motion.span>
            )}
        </motion.button>
    )
}
