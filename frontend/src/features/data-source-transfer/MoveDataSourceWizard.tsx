/**
 * MoveDataSourceWizard — moving a data source, with its views and who can
 * read them, to another workspace.
 *
 *   1. Destination — where it can go, and whether that is a move or a request.
 *   2. What moves  — the views, the version history, the settings, and
 *                    anything that has to be resolved first.
 *   3. Access      — who keeps, gains and loses access. The destination's own
 *                    membership decides who reads the moved views, so this is
 *                    what that means, not a choice. Skipped when no views move.
 *   4. Confirm     — the move in plain sentences, and why. When anyone loses
 *                    access, the person says they understand before it goes.
 *
 * Someone who runs both workspaces moves it now and can undo it for a week;
 * someone who runs only this one sends a request the destination's admins
 * answer. The move is confirmed against the exact preview the person read:
 * if anything in it changed meanwhile, the server says so (409) and the
 * wizard goes back to show the latest rather than doing something unread.
 */
import { startTransition, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
    AlertTriangle, ArrowLeft, ArrowRightLeft, Check, ClipboardCheck, ExternalLink, Eye, Loader2, MapPin,
    RefreshCw, Send, Undo2, Users,
} from 'lucide-react'

import { WizardShell, type WizardStepDef } from '@/components/wizard/WizardShell'
import { ReasonField } from '@/components/activity/ReasonField'
import { useReasonDraft } from '@/components/activity/useReasonDraft'
import { useAppNotifications } from '@/components/ui/notifications'
import { Skeleton } from '@/components/ui/Skeleton'
import { formatUtc } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import { httpStatusOf } from '@/services/graphRequestFailure'
import type {
    DataSourceTransferResponse, TransferDestination, TransferMode, TransferPreview,
} from '@/services/dataSourceTransferService'
import { AccessPlanList } from './AccessPlanList'
import { DestinationStep } from './DestinationStep'
import { TransferPreviewSummary } from './TransferPreviewSummary'
import { UndoMoveDialog } from './UndoMoveDialog'
import { plural, toldHowBackIn, whoLoses, workspaceLabel } from './transferCopy'
import {
    useMoveDestinations, useMovePreview, useTransferActions, useTransferHistory,
} from './useDataSourceTransfers'

type StepId = 'destination' | 'preview' | 'access' | 'confirm'

const STEP_DEFS: Record<StepId, WizardStepDef> = {
    destination: { id: 'destination', label: 'Destination', icon: <MapPin className="w-6 h-6" /> },
    preview: { id: 'preview', label: 'What moves', icon: <Eye className="w-6 h-6" /> },
    access: { id: 'access', label: 'Access', icon: <Users className="w-6 h-6" /> },
    confirm: { id: 'confirm', label: 'Confirm', icon: <ClipboardCheck className="w-6 h-6" /> },
}

export interface MoveDataSourceWizardProps {
    isOpen: boolean
    sourceWorkspace: { id: string; name: string }
    dataSource: { id: string; label: string }
    /** Skip the Destination step: the Add Data Source wizard pulling a source here. */
    presetDestinationId?: string
    onClose: () => void
    /** A move happened, was undone, or a request went out — the page refreshes. */
    onDone?: (transfer: DataSourceTransferResponse) => void
}

export function MoveDataSourceWizard(props: MoveDataSourceWizardProps) {
    if (!props.isOpen) return null
    // Keyed so every opening starts clean, whichever source it is for.
    return (
        <MoveWizardBody
            key={`${props.sourceWorkspace.id}:${props.dataSource.id}:${props.presetDestinationId ?? ''}`}
            {...props}
        />
    )
}

function MoveWizardBody({ sourceWorkspace, dataSource, presetDestinationId, onClose, onDone }: MoveDataSourceWizardProps) {
    const navigate = useNavigate()
    const { notify } = useAppNotifications()
    const wsId = sourceWorkspace.id
    const dsId = dataSource.id
    const label = dataSource.label

    const [step, setStep] = useState<StepId>(presetDestinationId ? 'preview' : 'destination')
    const [destId, setDestId] = useState<string | null>(presetDestinationId ?? null)
    const [destMode, setDestMode] = useState<TransferMode | null>(null)
    // The preview whose impact the person said they understand: a new picture asks again.
    const [ackToken, setAckToken] = useState<string | null>(null)
    const [phase, setPhase] = useState<'steps' | 'working' | 'done' | 'undone'>('steps')
    const [result, setResult] = useState<DataSourceTransferResponse | null>(null)
    const [submitError, setSubmitError] = useState<string | null>(null)
    const [stale, setStale] = useState<string | null>(null)
    const [undoing, setUndoing] = useState(false)
    const draft = useReasonDraft('move')

    const destinations = useMoveDestinations(wsId, dsId, !presetDestinationId)
    const previewQuery = useMovePreview(wsId, dsId, destId, !!destId)
    const history = useTransferHistory(wsId, dsId)
    const actions = useTransferActions()
    const pending = history.transfers?.find(t => t.status === 'pending') ?? null

    const pv: TransferPreview | undefined = previewQuery.preview
    const mode: TransferMode | null = pv ? pv.mode : destMode
    const fromName = workspaceLabel(pv?.fromWorkspace.name ?? sourceWorkspace.name)
    const toName = workspaceLabel(pv?.toWorkspace.name)
    const counts = pv?.viewCounts
    const liveViews = counts ? counts.private + counts.workspace + counts.enterprise : 1
    // A request may go out while something that clears by itself is in the way;
    // a move may not, and nothing may while something permanent is.
    const blocked = !pv || !mode || pv.blockers.some(b => mode === 'direct' || !b.transient)

    const steps = useMemo(() => ([
        ...(presetDestinationId ? [] : ['destination' as const]),
        'preview' as const,
        ...(liveViews > 0 ? ['access' as const] : []),
        'confirm' as const,
    ]), [presetDestinationId, liveViews])
    const current: StepId = steps.includes(step) ? step : 'preview'
    const stepIndex = steps.indexOf(current)
    const go = (id: StepId) => startTransition(() => setStep(id))

    const loses = pv?.access.loses ?? []
    const lostGroups = loses.filter(s => s.type === 'group').length
    const losing = whoLoses(loses.length - lostGroups, lostGroups)
    const acknowledged = loses.length === 0 || (!!pv && ackToken === pv.token)

    const canProceed = current === 'destination'
        ? !!destId && !!destMode
        : current === 'preview' ? !previewQuery.isFetching && !blocked
            : true

    const chooseDestination = (d: TransferDestination) => {
        setDestId(d.id)
        setDestMode(d.mode)
        setAckToken(null)
        setStale(null)
    }

    const submit = async () => {
        if (!pv || !destId || !mode || blocked || !acknowledged) return
        setSubmitError(null)
        setStale(null)
        setPhase('working')
        const vars = {
            wsId,
            dsId,
            body: { targetWorkspaceId: destId, previewToken: pv.token },
            reason: draft.take(),
        }
        try {
            const transfer = mode === 'direct'
                ? await actions.move.mutateAsync(vars)
                : await actions.propose.mutateAsync(vars)
            setResult(transfer)
            setPhase('done')
            onDone?.(transfer)
        } catch (err) {
            const message = err instanceof Error && err.message ? err.message : 'The move didn’t go through.'
            setPhase('steps')
            if (httpStatusOf(err) === 409) {
                // Something changed since the preview was read: show the latest.
                setStale(message)
                go('preview')
                void previewQuery.refetch()
            } else {
                setSubmitError(message)
            }
        }
    }

    const cancelPending = (id: string, after?: () => void) => actions.cancel.mutate({ id }, {
        onSuccess: (t) => {
            notify('info', `Cancelled the request to move “${label}” to ${workspaceLabel(t.toWorkspace.name)}.`)
            after?.()
        },
        onError: (err) => notify('error', (err as Error).message),
    })

    const terminalPhase = phase === 'working' ? 'creating' as const
        : phase === 'done' || phase === 'undone' ? 'success' as const : undefined
    const isRequest = result?.kind === 'request' || (!result && mode === 'request')

    return (
        <>
            <WizardShell
                title={`Move “${label}”`}
                submitLabel={mode === 'request' ? 'Send request' : `Move to ${toName}`}
                currentStep={current}
                activeSteps={steps.map(id => STEP_DEFS[id])}
                currentStepIndex={Math.max(stepIndex, 0)}
                onStepClick={id => go(id as StepId)}
                onBack={() => go(steps[Math.max(stepIndex - 1, 0)])}
                onNext={() => go(steps[Math.min(stepIndex + 1, steps.length - 1)])}
                onClose={onClose}
                canProceed={canProceed}
                isLastStep={false}
                isSubmitting={phase === 'working'}
                onSubmit={() => void submit()}
                terminalPhase={terminalPhase}
                terminalLabel={phase === 'working'
                    ? (isRequest ? 'Sending' : 'Moving')
                    : phase === 'undone' ? 'Moved back' : isRequest ? 'Sent' : 'Moved'}
                terminalSubtitle={phase === 'working'
                    ? (isRequest ? `Asking ${toName}’s admins…` : `Moving “${label}” and its views…`)
                    : phase === 'undone' ? `“${label}” is back in ${fromName}`
                        : isRequest ? `Waiting for ${toName}’s admins` : `“${label}” now lives in ${toName}`}
                hideClose={phase === 'working'}
                wide={current === 'destination' && phase === 'steps'}
                helpSlug="workspace-admin"
                footer={phase === 'working' ? (
                    <div className="flex items-center gap-2 text-ink-muted w-full justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-sm">{isRequest ? 'Sending…' : 'Moving…'}</span>
                    </div>
                ) : phase !== 'steps' && result ? (
                    <TerminalFooter
                        result={result}
                        undone={phase === 'undone'}
                        toName={toName}
                        cancelling={actions.cancel.isPending}
                        onUndo={() => setUndoing(true)}
                        onOpen={() => { onClose(); navigate(`/workspaces/${result.toWorkspace.id}?ds=${dsId}`) }}
                        onCancelRequest={() => cancelPending(result.id, onClose)}
                        onDone={onClose}
                    />
                ) : current === 'confirm' ? (
                    <ConfirmFooter
                        mode={mode}
                        toName={toName}
                        disabled={blocked || !acknowledged}
                        onBack={() => go(steps[Math.max(stepIndex - 1, 0)])}
                        onCancel={onClose}
                        onSubmit={() => void submit()}
                    />
                ) : undefined}
            >
                {phase === 'working' && (
                    <div className="flex flex-col items-center justify-center py-16 gap-4">
                        <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
                        <p className="text-sm text-ink-muted">
                            {isRequest ? `Sending your request to ${toName}…` : `Moving “${label}” and its views to ${toName}…`}
                        </p>
                    </div>
                )}

                {phase !== 'steps' && phase !== 'working' && result && (
                    <Terminal result={result} undone={phase === 'undone'} label={label} fromName={fromName} toName={toName} />
                )}

                {phase === 'steps' && current === 'destination' && (
                    <DestinationStep
                        sourceName={label}
                        fromName={fromName}
                        destinations={destinations.destinations}
                        isLoading={destinations.isLoading}
                        error={destinations.error}
                        onRetry={() => void destinations.refetch()}
                        selectedId={destId}
                        onSelect={chooseDestination}
                        pending={pending}
                        onCancelPending={pending ? () => cancelPending(pending.id) : undefined}
                        cancelling={actions.cancel.isPending}
                    />
                )}

                {phase === 'steps' && current === 'preview' && (
                    <div className="space-y-4">
                        <StepHeader
                            icon={<Eye className="w-5 h-5" />}
                            title="What moves"
                            subtitle={`Everything built on “${label}” goes with it, so nothing is left behind in ${fromName}.`}
                        />
                        {stale && (
                            <div role="status" className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5">
                                <RefreshCw className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" aria-hidden />
                                <p className="text-sm text-ink">
                                    Something changed — here’s the latest.
                                    <span className="block text-xs text-ink-muted mt-0.5">{stale}</span>
                                </p>
                            </div>
                        )}
                        {previewQuery.isLoading ? (
                            <PreviewSkeleton />
                        ) : previewQuery.error ? (
                            <div role="alert" className="flex items-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3">
                                <p className="flex-1 text-sm text-rose-600 dark:text-rose-400">
                                    Couldn’t work out what would move: {previewQuery.error.message}
                                </p>
                                <button type="button" onClick={() => void previewQuery.refetch()} className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-secondary hover:text-ink">
                                    <RefreshCw className="w-3.5 h-3.5" /> Retry
                                </button>
                            </div>
                        ) : pv ? (
                            <TransferPreviewSummary preview={pv} />
                        ) : null}
                    </div>
                )}

                {phase === 'steps' && current === 'access' && pv && (
                    <div className="space-y-4">
                        <StepHeader
                            icon={<Users className="w-5 h-5" />}
                            title="Who can see it afterwards"
                            subtitle={`Views shared with “everyone in ${fromName}” will be shared with everyone in ${toName} instead.`}
                        />
                        <AccessPlanList
                            access={pv.access}
                            fromName={fromName}
                            toName={toName}
                            requestMode={mode === 'request'}
                        />
                    </div>
                )}

                {phase === 'steps' && current === 'confirm' && pv && (
                    <div className="space-y-5">
                        <StepHeader
                            icon={<ClipboardCheck className="w-5 h-5" />}
                            title={mode === 'request' ? `Ask ${toName} to take it` : `Move it to ${toName}`}
                            subtitle="Read it through once — this is exactly what will happen."
                        />
                        <Receipt preview={pv} label={label} fromName={fromName} toName={toName} losing={losing} />
                        {loses.length > 0 && (
                            <label className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={acknowledged}
                                    onChange={e => setAckToken(e.target.checked ? pv.token : null)}
                                    className="mt-0.5 accent-amber-500 cursor-pointer"
                                />
                                <span className="text-sm text-ink">
                                    I understand {losing} lose access to views that move.
                                    <span className="block text-xs text-ink-muted mt-0.5">
                                        {mode === 'request'
                                            ? `${toName}’s admins see who before they accept.`
                                            : `${toldHowBackIn(pv.access.requestPolicy, toName)}, and both workspaces’ admins are told who.`}
                                    </span>
                                </span>
                            </label>
                        )}
                        <ReasonField
                            draft={draft}
                            audience="workspace"
                            note={mode === 'request'
                                ? `Both workspaces’ admins see it, and ${toName}’s admins read it with your request.`
                                : 'Both workspaces’ admins see it.'}
                        />
                        <p className="text-xs text-ink-muted">
                            {mode === 'request'
                                ? `${toName}’s admins have 14 days to accept. You can cancel the request until then.`
                                : `You can undo this for 7 days, as long as nothing new is built on it in ${toName}.`}
                        </p>
                        {submitError && (
                            <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3.5 py-2.5">
                                <AlertTriangle className="w-4 h-4 mt-0.5 text-rose-500 shrink-0" aria-hidden />
                                <p className="text-sm text-rose-600 dark:text-rose-400">{submitError}</p>
                            </div>
                        )}
                    </div>
                )}
            </WizardShell>

            {undoing && result && (
                <UndoMoveDialog
                    transfer={result}
                    onClose={() => setUndoing(false)}
                    onUndone={(t) => { setResult(t); setPhase('undone'); onDone?.(t) }}
                />
            )}
        </>
    )
}

function StepHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
    return (
        <div className="flex items-start gap-3">
            <span className="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">{icon}</span>
            <div>
                <h3 className="text-lg font-bold text-ink">{title}</h3>
                <p className="text-sm text-ink-muted">{subtitle}</p>
            </div>
        </div>
    )
}

function PreviewSkeleton() {
    return (
        <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-20 w-full rounded-2xl" />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {[0, 1, 2].map(i => <Skeleton key={i} className="h-28 rounded-2xl" />)}
            </div>
            {[0, 1, 2].map(i => <Skeleton key={i} className="h-9 w-full rounded-xl" />)}
        </div>
    )
}

/** The move in sentences — what a careful person would want to read last. */
function Receipt({ preview: pv, label, fromName, toName, losing }: {
    preview: TransferPreview
    label: string
    fromName: string
    toName: string
    /** "3 people and 1 group", or "No one". */
    losing: string
}) {
    const c = pv.viewCounts
    const lines = [
        c.total
            ? `${plural(c.total, 'view')} move with it${c.trashed ? `, including ${c.trashed} in the trash` : ''}.`
            : 'No views are built on it.',
        pv.versioning ? `Its version history comes too — ${plural(pv.versioning.commits, 'revision')}.` : null,
        'Aggregation, freshness settings and statistics come with it, so nothing is rebuilt.',
        pv.access.loses.length
            ? `${losing} in ${fromName} lose access to the views shared there; ${toName}’s members read them instead.`
            : null,
        pv.primary.becomesPrimary ? `It becomes ${toName}’s primary data source.` : null,
        pv.primary.wasPrimary ? `${fromName} has no primary data source until someone picks one.` : null,
    ].filter((l): l is string => !!l)
    return (
        <div className="rounded-2xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-sky-500" />
            <div className="px-5 py-4">
                <p className="text-sm font-semibold text-ink flex items-center gap-2">
                    <ArrowRightLeft className="w-4 h-4 text-indigo-500" aria-hidden />
                    “{label}” moves from {fromName} to {toName}.
                </p>
                <ul className="mt-2.5 space-y-1.5">
                    {lines.map(line => (
                        <li key={line} className="flex items-start gap-2 text-sm text-ink-secondary">
                            <Check className="w-3.5 h-3.5 mt-0.5 text-emerald-500 shrink-0" aria-hidden />
                            {line}
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    )
}

function ConfirmFooter({ mode, toName, disabled, onBack, onCancel, onSubmit }: {
    mode: TransferMode | null
    toName: string
    disabled: boolean
    onBack: () => void
    onCancel: () => void
    onSubmit: () => void
}) {
    const request = mode === 'request'
    return (
        <>
            <button
                onClick={onBack}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
            >
                <ArrowLeft className="w-4 h-4" />
                Back
            </button>
            <div className="flex items-center gap-3">
                <button
                    onClick={onCancel}
                    className="px-5 py-2.5 rounded-xl font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
                >
                    Cancel
                </button>
                <button
                    onClick={onSubmit}
                    disabled={disabled}
                    className={cn(
                        'flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium transition-colors duration-150',
                        disabled
                            ? 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed'
                            : request
                                ? 'bg-gradient-to-r from-sky-500 to-indigo-600 text-white hover:brightness-110 shadow-md'
                                : 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md',
                    )}
                >
                    {request ? <Send className="w-4 h-4" /> : <ArrowRightLeft className="w-4 h-4" />}
                    {request ? 'Send request' : `Move to ${toName}`}
                </button>
            </div>
        </>
    )
}

function Terminal({ result, undone, label, fromName, toName }: {
    result: DataSourceTransferResponse
    undone: boolean
    label: string
    fromName: string
    toName: string
}) {
    const request = result.kind === 'request' && result.status === 'pending'
    return (
        <div className="flex flex-col items-center justify-center py-12 gap-5 text-center">
            <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', damping: 12, stiffness: 220 }}
                className={cn(
                    'w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg',
                    undone ? 'bg-gradient-to-br from-amber-500 to-orange-600 shadow-amber-500/25'
                        : request ? 'bg-gradient-to-br from-sky-500 to-indigo-600 shadow-sky-500/25'
                            : 'bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/25',
                )}
            >
                {undone ? <Undo2 className="w-8 h-8 text-white" /> : request ? <Send className="w-8 h-8 text-white" /> : <Check className="w-8 h-8 text-white" />}
            </motion.div>
            <div>
                <h3 className="text-xl font-bold text-ink">
                    {undone ? `“${label}” is back in ${fromName}` : request ? `Request sent to ${toName}` : `“${label}” now lives in ${toName}`}
                </h3>
                <p className="text-sm text-ink-muted mt-1 max-w-md">
                    {undone
                        ? `Its views went back with it, and ${fromName}’s members can read them again.`
                        : request
                            ? `Its admins have until ${formatUtc(result.expiresAt)} to accept. You’ll hear in your Inbox either way.`
                            : 'Its views, version history and settings came with it.'}
                </p>
            </div>
            {!undone && !request && (
                <div className="flex flex-wrap justify-center gap-2">
                    <span className="rounded-full border border-black/[0.08] dark:border-white/[0.10] px-3 py-1 text-xs text-ink-secondary tabular-nums">
                        {plural(result.viewCount, 'view')} moved
                    </span>
                    {result.lostAccess.people + result.lostAccess.groups > 0 && (
                        <span className="rounded-full border border-black/[0.08] dark:border-white/[0.10] px-3 py-1 text-xs text-ink-secondary tabular-nums">
                            {whoLoses(result.lostAccess.people, result.lostAccess.groups)} told how to get back in
                        </span>
                    )}
                </div>
            )}
        </div>
    )
}

function TerminalFooter({ result, undone, toName, cancelling, onUndo, onOpen, onCancelRequest, onDone }: {
    result: DataSourceTransferResponse
    undone: boolean
    toName: string
    cancelling: boolean
    onUndo: () => void
    onOpen: () => void
    onCancelRequest: () => void
    onDone: () => void
}) {
    const request = result.kind === 'request' && result.status === 'pending'
    return (
        <div className="flex items-center justify-between w-full gap-3">
            <div>
                {!undone && !request && result.canUndo && (
                    <button
                        onClick={onUndo}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 transition-colors"
                    >
                        <Undo2 className="w-4 h-4" />
                        Undo
                    </button>
                )}
                {request && result.canCancel && (
                    <button
                        onClick={onCancelRequest}
                        disabled={cancelling}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                    >
                        {cancelling && <Loader2 className="w-4 h-4 animate-spin" />}
                        Cancel request
                    </button>
                )}
            </div>
            <div className="flex items-center gap-3">
                {!undone && !request && (
                    <button
                        onClick={onOpen}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                        <ExternalLink className="w-4 h-4" />
                        Open in {toName}
                    </button>
                )}
                <button
                    onClick={onDone}
                    className="flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-md hover:from-emerald-700 hover:to-teal-700 transition-colors"
                >
                    <Check className="w-4 h-4" />
                    Done
                </button>
            </div>
        </div>
    )
}
