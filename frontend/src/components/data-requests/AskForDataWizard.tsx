/**
 * AskForDataWizard — asking for data to be connected to a workspace, step by step.
 *
 * For anyone who can read a workspace and needs data it doesn't have — a business user
 * who knows "the finance marts in Snowflake", or an engineer who can name the schema.
 * Three steps — what and from where, why and by when (and who knows it), a last look —
 * then the request goes to the platform team and the workspace's admins, and is followed
 * under Data → Sources. Mounted once in the app shell; opened with `useAskForDataWizard`.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Check, Loader2, Search, Send, Target } from 'lucide-react'
import { WizardShell, type WizardStepDef } from '@/components/wizard/WizardShell'
import { useAppNotifications } from '@/components/ui/notifications'
import { useAuthStore } from '@/store/auth'
import { useAskForDataWizard, useDataRequestActions, type AskTarget } from '@/hooks/useDataRequests'
import { ReviewStep, TITLE_MAX, WhatStep, WhyStep, type AskDraft, type PersonChip } from './AskForDataSteps'
import { DataRequestProgress } from './DataRequestProgress'

type StepId = 'what' | 'why' | 'review'
const STEPS: StepId[] = ['what', 'why', 'review']
const STEP_DEFS: Record<StepId, WizardStepDef> = {
    what: { id: 'what', label: 'What', icon: <Search className="w-4 h-4" /> },
    why: { id: 'why', label: 'Why & when', icon: <Target className="w-4 h-4" /> },
    review: { id: 'review', label: 'Review & send', icon: <Send className="w-4 h-4" /> },
}

const EMPTY: AskDraft = { title: '', system: null, details: '', purpose: '', urgency: 'no_rush', contactIds: [] }

/** The app shell's one wizard: renders while it is open. */
export function AskForDataWizardHost() {
    const { workspace, closeWizard } = useAskForDataWizard()
    if (!workspace) return null
    return <AskForDataWizard workspace={workspace} onClose={closeWizard} />
}

export function AskForDataWizard({ workspace, onClose }: { workspace: AskTarget; onClose: () => void }) {
    const navigate = useNavigate()
    const { notify } = useAppNotifications()
    const meId = useAuthStore(s => s.user?.id)
    const { submit } = useDataRequestActions()
    const [draft, setDraft] = useState<AskDraft>(EMPTY)
    const [contacts, setContacts] = useState<PersonChip[]>([])
    const [step, setStep] = useState<StepId>('what')
    const [phase, setPhase] = useState<'steps' | 'sending' | 'sent'>('steps')

    const patch = (p: Partial<AskDraft>) => setDraft(d => ({ ...d, ...p }))
    const index = STEPS.indexOf(step)
    const titleOk = draft.title.trim().length > 0 && draft.title.trim().length <= TITLE_MAX
    const canProceed = step === 'what' ? !!draft.system && titleOk : true

    const send = async () => {
        if (!draft.system) return
        setPhase('sending')
        try {
            await submit.mutateAsync({
                workspaceId: workspace.id,
                draft: {
                    title: draft.title.trim(), system: draft.system, urgency: draft.urgency,
                    details: draft.details?.trim() || undefined, purpose: draft.purpose?.trim() || undefined,
                    contactIds: contacts.map(c => c.id),
                },
            })
            setPhase('sent')
        } catch (e) {
            setPhase('steps')
            notify('error', e instanceof Error ? e.message : 'Couldn’t send your request.')
        }
    }

    return (
        <WizardShell
            title="Ask for data"
            submitLabel="Send request"
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
            terminalSubtitle={phase === 'sending' ? 'Sending it to the platform team…' : 'With the platform team'}
            hideClose={phase === 'sending'}
            wide
            helpSlug="requesting-data"
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
                    <button type="button" onClick={() => { onClose(); navigate(`/workspaces/${workspace.id}?tab=data&section=sources`) }}
                        className="inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-500 shadow-md shadow-indigo-500/25 hover:brightness-110">
                        Track it <ArrowRight className="h-4 w-4" aria-hidden />
                    </button>
                </div>
            ) : undefined}
        >
            {phase === 'sent' ? (
                <Sent title={draft.title.trim()} workspaceName={workspace.name} />
            ) : phase === 'sending' ? (
                <div className="flex flex-col items-center justify-center gap-4 py-16">
                    <Loader2 className="h-10 w-10 animate-spin text-indigo-500" />
                    <p className="text-sm text-ink-muted">Sending “{draft.title.trim()}” to the platform team…</p>
                </div>
            ) : (
                <>
                    {step === 'what' && <WhatStep draft={draft} onChange={patch} workspaceName={workspace.name} />}
                    {step === 'why' && (
                        <WhyStep draft={draft} onChange={patch} contacts={contacts} meId={meId}
                            onAddContact={p => setContacts(c => c.some(x => x.id === p.id) ? c : [...c, p])}
                            onRemoveContact={id => setContacts(c => c.filter(x => x.id !== id))} />
                    )}
                    {step === 'review' && <ReviewStep draft={draft} contacts={contacts} workspaceName={workspace.name} />}
                </>
            )}
        </WizardShell>
    )
}

function Sent({ title, workspaceName }: { title: string; workspaceName: string }) {
    return (
        <div className="mx-auto flex max-w-xl flex-col items-center py-8 text-center">
            <span className="relative mb-5 flex h-16 w-16 items-center justify-center">
                <span aria-hidden className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping [animation-iteration-count:2]" />
                <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/30">
                    <Check className="h-8 w-8" aria-hidden />
                </span>
            </span>
            <h3 className="font-display text-2xl font-bold text-ink">Request sent</h3>
            <p className="mt-1.5 text-sm text-ink-secondary">
                “{title}” is with the platform team. You’ll hear in your Inbox when someone takes it on and when it’s connected — and anyone in {workspaceName} can follow it under Data → Sources.
            </p>
            <div className="mt-7 w-full rounded-2xl border border-glass-border bg-canvas-elevated p-5 text-left">
                <DataRequestProgress status="pending" />
            </div>
        </div>
    )
}
