/**
 * RequestWorkspaceWizard — asking for a workspace of your own, step by step.
 *
 * For someone who can't create workspaces: once they've found their feet in the
 * Playground, this is how they get a real one. Four steps — what it's for, who it's
 * for, what it will work with, a last look — then the request goes to the platform
 * team (platform and org admins), who approve it, ask a question, or decline. A
 * request sent back opens here again, with the question on top, to answer and resend.
 *
 * The draft is kept on this browser as it is written, so closing the wizard loses
 * nothing. Mounted once in the app shell; opened with `useRequestWorkspaceWizard`.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Check, Database, Loader2, MessageCircleQuestion, Send, Sparkles, Users } from 'lucide-react'
import { WizardShell, type WizardStepDef } from '@/components/wizard/WizardShell'
import { useAppNotifications } from '@/components/ui/notifications'
import { listViews } from '@/services/viewApiService'
import {
    nameTakenSuggestion, type WorkspaceRequest, type WorkspaceRequestDraft,
} from '@/services/workspaceRequestsService'
import { useRequestWorkspaceWizard, useWorkspaceRequestActions } from '@/hooks/useWorkspaceRequests'
import { usePlayground } from '@/hooks/usePlayground'
import { useAuthStore } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'
import { DataStep, PurposeStep, ReviewStep, TeamStep, type GraphOption, type PersonChip } from './RequestSteps'
import { NextSteps } from './NextSteps'

type StepId = 'purpose' | 'team' | 'data' | 'review'
const STEPS: StepId[] = ['purpose', 'team', 'data', 'review']
const STEP_DEFS: Record<StepId, WizardStepDef> = {
    purpose: { id: 'purpose', label: 'Purpose', icon: <Sparkles className="w-4 h-4" /> },
    team: { id: 'team', label: 'People', icon: <Users className="w-4 h-4" /> },
    data: { id: 'data', label: 'Data', icon: <Database className="w-4 h-4" /> },
    review: { id: 'review', label: 'Review', icon: <Send className="w-4 h-4" /> },
}

const EMPTY: WorkspaceRequestDraft = {
    name: '', description: '', purpose: 'team', teamName: '', teammateIds: [], playgroundSourceIds: [], dataNeeds: '', note: '',
}
const draftKey = (userId: string) => `nx-workspace-request-draft:${userId}`

/** A draft kept on this browser: `{ draft, teammates }`, or nothing when storage can't be read. */
function readDraft(userId: string | undefined): { draft: WorkspaceRequestDraft; teammates: PersonChip[] } | null {
    if (!userId) return null
    try {
        const raw = window.localStorage.getItem(draftKey(userId))
        return raw ? JSON.parse(raw) : null
    } catch {
        return null
    }
}

function fromRequest(r: WorkspaceRequest): { draft: WorkspaceRequestDraft; teammates: PersonChip[] } {
    return {
        draft: {
            name: r.name, description: r.description ?? '', purpose: r.purpose, teamName: r.teamName ?? '',
            teammateIds: r.teammateIds ?? [], playgroundSourceIds: r.playgroundSourceIds ?? [],
            dataNeeds: r.dataNeeds ?? '', note: '',
        },
        teammates: (r.teammates ?? r.teammateIds.map(id => ({ id, displayName: id }))).map(t => ({ id: t.id, name: t.displayName })),
    }
}

/** The app shell's one wizard: renders while it is open. */
export function RequestWorkspaceWizardHost() {
    const { open, editing, preselectedSourceIds, closeWizard } = useRequestWorkspaceWizard()
    if (!open) return null
    return <RequestWorkspaceWizard editing={editing} preselectedSourceIds={preselectedSourceIds} onClose={closeWizard} />
}

export function RequestWorkspaceWizard({ editing, preselectedSourceIds = [], onClose }: {
    editing?: WorkspaceRequest | null
    preselectedSourceIds?: string[]
    onClose: () => void
}) {
    const navigate = useNavigate()
    const { notify } = useAppNotifications()
    const me = useAuthStore(s => s.user)
    const meName = [me?.firstName, me?.lastName].filter(Boolean).join(' ') || me?.email || 'You'
    const actions = useWorkspaceRequestActions()

    // Where the wizard starts: the request sent back, else this browser's draft, else blank —
    // with any Playground graphs it was opened on already ticked.
    const [initial] = useState(() => {
        const start = editing ? fromRequest(editing) : readDraft(me?.id) ?? { draft: EMPTY, teammates: [] }
        const ids = Array.from(new Set([...start.draft.playgroundSourceIds, ...preselectedSourceIds]))
        return { ...start, draft: { ...start.draft, playgroundSourceIds: ids } }
    })
    const [draft, setDraft] = useState<WorkspaceRequestDraft>(initial.draft)
    const [teammates, setTeammates] = useState<PersonChip[]>(initial.teammates)
    const [step, setStep] = useState<StepId>('purpose')
    const [phase, setPhase] = useState<'steps' | 'sending' | 'sent'>('steps')
    const [nameError, setNameError] = useState<{ message: string; suggestion: string | null } | null>(null)

    const patch = (p: Partial<WorkspaceRequestDraft>) => {
        if ('name' in p) setNameError(null)
        setDraft(d => ({ ...d, ...p }))
    }

    // Kept as it is written (a new request only): closing the wizard loses nothing.
    useEffect(() => {
        if (editing || !me?.id || phase !== 'steps') return
        try { window.localStorage.setItem(draftKey(me.id), JSON.stringify({ draft, teammates })) } catch { /* this visit only */ }
    }, [draft, teammates, editing, me?.id, phase])

    // The person's own graphs in the Playground, with how many views each holds.
    const playground = usePlayground().data
    const pgWorkspace = useWorkspacesStore(s => s.workspaces.find(w => w.kind === 'playground'))
    const meId = me?.id
    const myGraphs = useMemo(
        () => (pgWorkspace?.dataSources ?? []).filter(ds => !!meId && ds.createdBy === meId),
        [pgWorkspace, meId],
    )
    const pgViews = useQuery({
        queryKey: ['workspace-request', 'playground-views', pgWorkspace?.id],
        queryFn: () => listViews({ workspaceIds: [pgWorkspace!.id], limit: 200 }),
        enabled: !!pgWorkspace && myGraphs.length > 0,
        staleTime: 60_000,
    }).data?.items ?? []
    const graphs: GraphOption[] = myGraphs.map(ds => ({
        id: ds.id, label: ds.label || ds.graphName || 'Untitled graph',
        viewCount: pgViews.filter(v => v.dataSourceId === ds.id).length,
    }))

    const index = STEPS.indexOf(step)
    const nameOk = draft.name.trim().length > 0 && draft.name.trim().length <= 120
    const canProceed = step === 'purpose' ? nameOk : step === 'review' && editing?.question ? !!draft.note?.trim() : true

    const send = async () => {
        const body: WorkspaceRequestDraft = {
            ...draft,
            name: draft.name.trim(),
            teammateIds: teammates.map(t => t.id),
            playgroundSourceIds: draft.playgroundSourceIds.filter(id => graphs.some(g => g.id === id)),
        }
        setPhase('sending')
        try {
            if (editing) await actions.resubmit.mutateAsync({ id: editing.id, draft: body })
            else await actions.submit.mutateAsync(body)
            if (!editing && me?.id) {
                try { window.localStorage.removeItem(draftKey(me.id)) } catch { /* nothing kept */ }
            }
            setPhase('sent')
        } catch (e) {
            setPhase('steps')
            const suggestion = nameTakenSuggestion(e)
            if (suggestion !== null || (e as { detail?: { type?: string } })?.detail?.type === 'name_taken') {
                setNameError({ message: 'A workspace already has that name.', suggestion })
                setStep('purpose')
                return
            }
            notify('error', e instanceof Error ? e.message : 'Couldn’t send your request.')
        }
    }

    const title = editing ? `Answer: “${editing.name}”` : 'Request a workspace'
    return (
        <WizardShell
            title={title}
            submitLabel={editing ? 'Send it back' : 'Send request'}
            currentStep={step}
            activeSteps={STEPS.map(id => STEP_DEFS[id])}
            currentStepIndex={index}
            onStepClick={id => setStep(id as StepId)}
            onBack={() => setStep(STEPS[Math.max(index - 1, 0)])}
            onNext={() => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)])}
            onClose={onClose}
            canProceed={canProceed}
            isLastStep={step === 'review'}
            isSubmitting={phase === 'sending'}
            onSubmit={() => void send()}
            terminalPhase={phase === 'sending' ? 'creating' : phase === 'sent' ? 'success' : undefined}
            terminalLabel={phase === 'sending' ? 'Sending' : 'Sent'}
            terminalSubtitle={phase === 'sending' ? 'Sending it to the platform team…' : 'Waiting for the platform team'}
            hideClose={phase === 'sending'}
            wide
            helpSlug="requesting-a-workspace"
            footer={phase === 'sending' ? (
                <div className="flex w-full items-center justify-center gap-2 text-ink-muted">
                    <Loader2 className="h-4 w-4 animate-spin" /> <span className="text-sm">Sending…</span>
                </div>
            ) : phase === 'sent' ? (
                <div className="flex w-full items-center justify-end gap-2">
                    <button type="button" onClick={onClose}
                        className="h-9 rounded-xl px-4 text-sm font-semibold text-ink-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                        Done
                    </button>
                    <button type="button" onClick={() => { onClose(); navigate('/my/access?tab=workspaces') }}
                        className="inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25 hover:brightness-110">
                        Track it <ArrowRight className="h-4 w-4" aria-hidden />
                    </button>
                </div>
            ) : undefined}
        >
            {phase === 'sent' ? (
                <Sent name={draft.name.trim()} resent={!!editing} />
            ) : phase === 'sending' ? (
                <div className="flex flex-col items-center justify-center gap-4 py-16">
                    <Loader2 className="h-10 w-10 animate-spin text-violet-500" />
                    <p className="text-sm text-ink-muted">Sending “{draft.name.trim()}” to the platform team…</p>
                </div>
            ) : (
                <>
                    {editing?.question && (
                        <div className="mx-auto mb-6 flex max-w-2xl items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] p-4">
                            <MessageCircleQuestion className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                            <div className="min-w-0">
                                <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">The platform team asks</p>
                                <p className="mt-0.5 text-sm text-ink">{editing.question}</p>
                            </div>
                        </div>
                    )}
                    {step === 'purpose' && (
                        <PurposeStep draft={draft} onChange={patch} nameError={nameError?.message} suggestion={nameError?.suggestion}
                            onUseSuggestion={name => patch({ name })} />
                    )}
                    {step === 'team' && (
                        <TeamStep draft={draft} onChange={patch} teammates={teammates} meId={me?.id} meName={meName}
                            onAddTeammate={p => setTeammates(t => t.some(x => x.id === p.id) ? t : [...t, p])}
                            onRemoveTeammate={id => setTeammates(t => t.filter(x => x.id !== id))} />
                    )}
                    {step === 'data' && <DataStep draft={draft} onChange={patch} graphs={graphs} playgroundOn={!!playground?.enabled && !!pgWorkspace} />}
                    {step === 'review' && (
                        <ReviewStep draft={draft} onChange={patch} teammates={teammates} graphs={graphs} meName={meName} question={editing?.question} />
                    )}
                </>
            )}
        </WizardShell>
    )
}

function Sent({ name, resent }: { name: string; resent: boolean }) {
    return (
        <div className="mx-auto flex max-w-xl flex-col items-center py-8 text-center">
            <span className="relative mb-5 flex h-16 w-16 items-center justify-center">
                <span aria-hidden className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping [animation-iteration-count:2]" />
                <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/30">
                    <Check className="h-8 w-8" aria-hidden />
                </span>
            </span>
            <h3 className="font-display text-2xl font-bold text-ink">{resent ? 'Sent back' : 'Request sent'}</h3>
            <p className="mt-1.5 text-sm text-ink-secondary">
                “{name}” is with the platform team. You’ll hear in your inbox the moment they answer — and you can follow it on My access.
            </p>
            <div className="mt-7 w-full rounded-2xl border border-glass-border bg-canvas-elevated p-5 text-left">
                <NextSteps reached={1} />
            </div>
        </div>
    )
}
