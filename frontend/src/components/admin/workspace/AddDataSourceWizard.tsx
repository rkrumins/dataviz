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
import { useState, useMemo, useCallback, startTransition } from 'react'
import { motion } from 'framer-motion'
import {
    Database, BookOpen, ClipboardCheck, Check, Loader2, AlertTriangle, Sparkles, MoveRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { WizardShell, type WizardStepDef } from '@/components/wizard/WizardShell'
import { CatalogItemPicker, isMovable, type PickableCatalogItem } from '@/components/wizard/CatalogItemPicker'
import { useQuery } from '@tanstack/react-query'
import { workspaceService } from '@/services/workspaceService'
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

    const items: PickableCatalogItem[] = useMemo(() => {
        const owner = new Map(
            (bindingsQuery.data ?? []).map(b => [b.id, b]),
        )
        return catalogItems.map(item => {
            const b = owner.get(item.id)
            return b
                ? { ...item, boundWorkspaceId: b.boundWorkspaceId, boundWorkspaceName: b.boundWorkspaceName }
                : item
        })
    }, [catalogItems, bindingsQuery.data])

    const selected = items.find(c => c.id === catalogItemId)
    const chosenOntology = ontologies.find(o => o.id === ontologyId)

    // Picking a source that ALREADY belongs to another workspace is a MOVE, not an
    // attach. It only appears when nothing is built on it — the server refuses the
    // rest with a 409.
    const isMove = Boolean(selected && isMovable(selected, workspaceId))

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
        setStep('source'); setCatalogItemId(''); setLabel(''); setOntologyId('')
        setPhase('steps'); setError(null)
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
                if (label.trim() || ontologyId) {
                    await workspaceService.updateDataSource(workspaceId, selected.boundDataSourceId, {
                        label: label.trim() || undefined,
                        ontologyId: ontologyId || undefined,
                    })
                }
            } else {
                await workspaceService.addDataSource(workspaceId, {
                    catalogItemId,
                    label: label.trim() || undefined,
                    ontologyId: ontologyId || undefined,
                })
            }
            setPhase('success')
        } catch (err) {
            setError(err instanceof Error
                ? err.message
                : isMove ? 'Could not move the data source.' : 'Could not attach the data source.')
            setPhase('steps')
            setStep('review')
        }
    }, [workspaceId, catalogItemId, label, ontologyId, isMove, selected])

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

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <OntologyCard
                            selected={ontologyId === ''}
                            onClick={() => setOntologyId('')}
                            title="System defaults"
                            subtitle="Classify with the built-in types"
                            meta="Recommended if you're not sure"
                            dashed
                        />
                        {ontologies.map(o => (
                            <OntologyCard
                                key={o.id}
                                selected={ontologyId === o.id}
                                onClick={() => setOntologyId(o.id)}
                                title={o.name}
                                subtitle={o.description || `Version ${o.version}`}
                                meta={`${Object.keys(o.entityTypeDefinitions ?? {}).length} entity types · ${Object.keys(o.relationshipTypeDefinitions ?? {}).length} relationships`}
                                published={o.isPublished}
                            />
                        ))}
                    </div>
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
                            hint={chosenOntology ? `v${chosenOntology.version}` : 'Built-in entity + relationship types'}
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

function OntologyCard({ selected, onClick, title, subtitle, meta, published, dashed }: {
    selected: boolean
    onClick: () => void
    title: string
    subtitle: string
    meta: string
    published?: boolean
    dashed?: boolean
}) {
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
            )}
        >
            <span className="flex items-center gap-2 min-w-0">
                {dashed
                    ? <Sparkles className="w-4 h-4 text-slate-400 shrink-0" />
                    : <BookOpen className="w-4 h-4 text-slate-400 shrink-0" />}
                <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">{title}</span>
                {published === false && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400">
                        DRAFT
                    </span>
                )}
            </span>
            <span className="text-xs text-slate-500 truncate">{subtitle}</span>
            <span className="text-[11px] text-slate-400 truncate">{meta}</span>

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
