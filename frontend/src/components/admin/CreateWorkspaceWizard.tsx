/**
 * CreateWorkspaceWizard — the premium shell, for the thing that creates workspaces.
 *
 * What it replaces (AdminWizard, via a `WizardStep[]` array of JSX literals built
 * inside WorkspacesPage's render):
 *   • Next was ALWAYS enabled. You clicked it, a validator ran, and a red box
 *     appeared underneath telling you what was wrong. Here Next is disabled until
 *     the step is valid, and an amber strip names the missing thing up front.
 *   • The data-source step was a native `<select>` whose first option was
 *     "Skip for now..." — so skipping looked like picking a source called "Skip".
 *   • Creation was invisible: the modal just closed, and you looked for your
 *     workspace in the list. Creating is now the last step, with a success state.
 *   • The name field checked for duplicates only when you tried to advance. It
 *     now checks as you type, and offers a free name when yours is taken — this
 *     instance has NINE workspaces called "Solidatus Test WS".
 */
import { useState, useMemo, useCallback, startTransition } from 'react'
import { motion } from 'framer-motion'
import {
    Boxes, Database, ClipboardCheck, Sparkles, AlertTriangle, Check,
    Loader2, ArrowRight, Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { WizardShell, type WizardStepDef } from '@/components/wizard/WizardShell'
import { CatalogItemPicker, type PickableCatalogItem } from '@/components/wizard/CatalogItemPicker'
import {
    workspaceService,
    type WorkspaceCreateRequest,
    type WorkspaceResponse,
} from '@/services/workspaceService'
import type { ProviderResponse } from '@/services/providerService'

const STEPS: WizardStepDef[] = [
    { id: 'basics', label: 'Basics', icon: <Boxes className="w-6 h-6" /> },
    { id: 'data', label: 'Data', icon: <Database className="w-6 h-6" /> },
    { id: 'review', label: 'Review', icon: <ClipboardCheck className="w-6 h-6" /> },
]

/** A free name near the one they wanted. Nine "Solidatus Test WS" is not an accident. */
function suggestFreeName(base: string, taken: Set<string>): string | null {
    const trimmed = base.trim()
    if (!trimmed) return null
    for (let n = 2; n <= 99; n++) {
        const candidate = `${trimmed} ${n}`
        if (!taken.has(candidate.toLowerCase())) return candidate
    }
    return null
}

export function CreateWorkspaceWizard({
    isOpen,
    onClose,
    onCreated,
    existingWorkspaces,
    catalogItems,
    providers,
}: {
    isOpen: boolean
    onClose: () => void
    onCreated: (ws: WorkspaceResponse) => void
    existingWorkspaces: WorkspaceResponse[]
    catalogItems: PickableCatalogItem[]
    providers: ProviderResponse[]
}) {
    const [step, setStep] = useState<string>('basics')
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [catalogItemId, setCatalogItemId] = useState('')
    const [label, setLabel] = useState('')

    const [phase, setPhase] = useState<'steps' | 'creating' | 'success'>('steps')
    const [created, setCreated] = useState<WorkspaceResponse | null>(null)
    const [error, setError] = useState<string | null>(null)

    const takenNames = useMemo(
        () => new Set(existingWorkspaces.map(w => w.name.trim().toLowerCase())),
        [existingWorkspaces],
    )

    const trimmed = name.trim()
    const isDuplicate = trimmed.length > 0 && takenNames.has(trimmed.toLowerCase())
    const freeName = isDuplicate ? suggestFreeName(trimmed, takenNames) : null

    const stepIndex = STEPS.findIndex(s => s.id === step)
    const isLastStep = stepIndex === STEPS.length - 1

    // Gate FORWARD instead of scolding backwards: Next is dead until the step is
    // genuinely valid, and `warning` says why.
    const canProceed = useMemo(() => {
        if (step === 'basics') return trimmed.length > 0 && !isDuplicate
        return true
    }, [step, trimmed, isDuplicate])

    const warning = useMemo(() => {
        if (step !== 'basics') return null
        if (!trimmed) return 'Give the workspace a name to continue.'
        if (isDuplicate) return `A workspace named “${trimmed}” already exists.`
        return null
    }, [step, trimmed, isDuplicate])

    const selectedItem = catalogItems.find(c => c.id === catalogItemId)

    const reset = useCallback(() => {
        setStep('basics'); setName(''); setDescription('')
        setCatalogItemId(''); setLabel('')
        setPhase('steps'); setCreated(null); setError(null)
    }, [])

    const handleClose = useCallback(() => {
        if (phase === 'creating') return  // never abandon a create in flight
        reset()
        onClose()
    }, [phase, reset, onClose])

    const handleSubmit = useCallback(async () => {
        setPhase('creating')
        setError(null)
        try {
            const req: WorkspaceCreateRequest = {
                name: trimmed,
                description: description.trim() || undefined,
                dataSources: catalogItemId
                    ? [{ catalogItemId, label: label.trim() || undefined }]
                    : [],
            }
            const ws = await workspaceService.create(req)
            setCreated(ws)
            setPhase('success')
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not create the workspace.')
            setPhase('steps')
            setStep('review')
        }
    }, [trimmed, description, catalogItemId, label])

    if (!isOpen) return null

    const terminalPhase = phase === 'steps' ? undefined : phase

    return (
        <WizardShell
            title="Create Workspace"
            submitLabel="Create workspace"
            currentStep={step}
            activeSteps={STEPS}
            currentStepIndex={stepIndex < 0 ? 0 : stepIndex}
            onStepClick={id => startTransition(() => setStep(id))}
            onBack={() => startTransition(() => setStep(STEPS[Math.max(stepIndex - 1, 0)].id))}
            onNext={() => startTransition(() => setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)].id))}
            onClose={handleClose}
            canProceed={canProceed}
            isLastStep={isLastStep}
            isSubmitting={phase === 'creating'}
            onSubmit={handleSubmit}
            terminalPhase={terminalPhase}
            terminalLabel={phase === 'success' ? 'Created' : 'Creating'}
            terminalSubtitle={
                phase === 'success'
                    ? `“${created?.name}” is ready`
                    : 'Creating your workspace…'
            }
            hideClose={phase === 'creating'}
            wide={step === 'data'}
            footer={
                phase === 'success' ? (
                    <div className="flex items-center justify-end gap-3 w-full">
                        <button
                            onClick={() => { const ws = created!; reset(); onClose(); onCreated(ws) }}
                            className="px-5 py-2.5 rounded-xl font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                        >
                            Done
                        </button>
                        <button
                            onClick={() => { const ws = created!; reset(); onClose(); onCreated(ws) }}
                            className="flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-md hover:from-emerald-700 hover:to-teal-700 transition-colors"
                        >
                            Open workspace
                            <ArrowRight className="w-4 h-4" />
                        </button>
                    </div>
                ) : phase === 'creating' ? (
                    <div className="flex items-center gap-2 text-slate-500 w-full justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-sm">Creating…</span>
                    </div>
                ) : undefined
            }
        >
            {phase === 'creating' && (
                <div className="flex flex-col items-center justify-center py-16 gap-4">
                    <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
                    <p className="text-sm text-slate-500">Creating “{trimmed}”…</p>
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
                            “{created?.name}” is ready
                        </h3>
                        <p className="text-sm text-slate-500 mt-1">
                            {catalogItemId
                                ? 'Your data source is attached. Open it to build a view.'
                                : 'It has no data yet — open it to attach a data source.'}
                        </p>
                    </div>
                </div>
            )}

            {phase === 'steps' && step === 'basics' && (
                <BasicsStep
                    name={name}
                    onName={setName}
                    description={description}
                    onDescription={setDescription}
                    isDuplicate={isDuplicate}
                    freeName={freeName}
                    onUseFreeName={() => freeName && setName(freeName)}
                />
            )}

            {phase === 'steps' && step === 'data' && (
                <div className="space-y-5">
                    <StepHeader
                        icon={<Database className="w-5 h-5" />}
                        title="Connect data (optional)"
                        subtitle="Attach a data source now, or leave it empty and connect one later."
                    />
                    <CatalogItemPicker
                        items={catalogItems}
                        providers={providers}
                        selectedId={catalogItemId}
                        onSelect={setCatalogItemId}
                        allowSkip
                    />
                    {catalogItemId && (
                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                                Label <span className="text-slate-400 font-normal">(optional)</span>
                            </label>
                            <input
                                value={label}
                                onChange={e => setLabel(e.target.value)}
                                placeholder={selectedItem?.name ?? 'e.g. Main Graph'}
                                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                            />
                            <p className="mt-1.5 text-xs text-slate-500">
                                What this source is called inside the workspace.
                            </p>
                        </div>
                    )}
                </div>
            )}

            {phase === 'steps' && step === 'review' && (
                <div className="space-y-5">
                    <StepHeader
                        icon={<ClipboardCheck className="w-5 h-5" />}
                        title="Ready to create"
                        subtitle="Check it over — you can change all of this afterwards."
                    />

                    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700 overflow-hidden">
                        <ReviewRow label="Name" value={trimmed || '—'} />
                        <ReviewRow label="Description" value={description.trim() || 'None'} />
                        <ReviewRow
                            label="Data source"
                            value={selectedItem?.name ?? 'None — attach one later'}
                            hint={selectedItem?.sourceIdentifier}
                        />
                        <ReviewRow label="Members" value="Just you, for now" icon={<Users className="w-3.5 h-3.5" />} />
                    </div>

                    {error && (
                        <div className="flex items-start gap-2 rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-4 py-3">
                            <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
                        </div>
                    )}
                </div>
            )}

            {/* Say WHY Next is dead, up front — instead of letting them click it and
                then explaining in red underneath. */}
            {phase === 'steps' && warning && (
                <div className="mt-5 flex items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                    <p className="text-xs text-amber-700 dark:text-amber-300">{warning}</p>
                </div>
            )}
        </WizardShell>
    )
}

// ── Pieces ─────────────────────────────────────────────────────────────────

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

function ReviewRow({ label, value, hint, icon }: {
    label: string
    value: string
    hint?: string
    icon?: React.ReactNode
}) {
    return (
        <div className="flex items-baseline gap-4 px-4 py-3">
            <span className="w-28 shrink-0 text-xs font-medium text-slate-500">{label}</span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white truncate">
                    {icon}{value}
                </span>
                {hint && <span className="block text-xs text-slate-400 truncate">{hint}</span>}
            </span>
        </div>
    )
}

function BasicsStep({
    name, onName, description, onDescription, isDuplicate, freeName, onUseFreeName,
}: {
    name: string
    onName: (v: string) => void
    description: string
    onDescription: (v: string) => void
    isDuplicate: boolean
    freeName: string | null
    onUseFreeName: () => void
}) {
    return (
        <div className="max-w-xl mx-auto space-y-6">
            <div className="text-center">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 text-xs font-semibold mb-3">
                    <Sparkles className="w-3.5 h-3.5" />
                    New workspace
                </span>
                <h3 className="text-2xl font-bold text-slate-900 dark:text-white">
                    What should we call it?
                </h3>
                <p className="text-sm text-slate-500 mt-1">
                    A workspace groups data sources, the views built on them, and the people who can see them.
                </p>
            </div>

            <div>
                <input
                    autoFocus
                    value={name}
                    onChange={e => onName(e.target.value)}
                    placeholder="e.g. Production Analytics"
                    className={cn(
                        'w-full px-4 py-4 rounded-xl border-2 text-lg text-slate-900 dark:text-white bg-white dark:bg-slate-800',
                        'placeholder:text-slate-400 focus:outline-none focus:ring-4 transition-colors',
                        isDuplicate
                            ? 'border-amber-400 focus:ring-amber-500/20'
                            : 'border-slate-200 dark:border-slate-700 focus:border-blue-500 focus:ring-blue-500/10',
                    )}
                />

                {/* A duplicate name is caught AS YOU TYPE, with a free one offered —
                    this instance has nine workspaces called "Solidatus Test WS". */}
                {isDuplicate && (
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            That name is taken.
                        </span>
                        {freeName && (
                            <button
                                type="button"
                                onClick={onUseFreeName}
                                className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                            >
                                Use “{freeName}” instead
                            </button>
                        )}
                    </div>
                )}
            </div>

            <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Description <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <textarea
                    value={description}
                    onChange={e => onDescription(e.target.value)}
                    rows={3}
                    placeholder="What lives in this workspace, and who it's for."
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 resize-none"
                />
            </div>
        </div>
    )
}
