/**
 * A new token for a key, doing exactly what the old one did.
 *
 * Rotating a live key: choose how long the old token keeps working beside the
 * new one — said as a moment ("your old key stops working Fri 14:00"), not a
 * duration, because the question is whether that is enough time to swap it
 * in everywhere.
 *
 * Renewing an expired key: there is no old token left to keep, so no grace to
 * choose. What it reaches today comes first — a renewed key gets the owner's
 * access as it is now, which may not be what it had. A paused key is not
 * renewed: signing in again resumes it, so it is rotated like a live one, and
 * the dialog says that rotating is not what resumes it.
 *
 * Either way it ends at the reveal: the one time the new token is shown.
 */
import { useEffect, useState } from 'react'
import { Check, Clock, Hourglass, PauseCircle, RotateCw, ShieldAlert, Timer, Zap } from 'lucide-react'

import { FieldLabel } from '@/components/admin/InviteWizard/ui'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/lib/utils'
import {
    ApiKeyError,
    apiKeyService,
    type ApiKey,
    type ApiKeyDetail,
    type ApiKeyOptions,
    type CreatedApiKey,
} from '@/services/apiKeyService'
import { AccessMatrix } from './AccessMatrix'
import { CloseConfirm } from './CloseConfirm'
import { ExpiryPicker } from './ExpiryPicker'
import { KeyDialog } from './KeyDialog'
import { RevealPanel } from './RevealPanel'
import { StepUpField } from './StepUpField'
import { customDateProblem, expiryFields, formatWhen, isRenewable, type ExpiryChoice } from './apiKeyFormat'
import { freshDraft, parkDraft, type ApiKeyDraft, type Grace } from './apiKeyDraft'

const GRACE: { value: Grace; label: string; sub: string; icon: typeof Zap }[] = [
    { value: 0, label: 'Right away', sub: 'For a key that may have leaked', icon: Zap },
    { value: 3600, label: 'In 1 hour', sub: 'Time to swap it in one place', icon: Timer },
    { value: 86400, label: 'In 1 day', sub: 'Time for a few services', icon: Clock },
    { value: 604800, label: 'In 7 days', sub: 'For a key used in many places', icon: Hourglass },
]

const DAY = 24 * 60 * 60 * 1000

/** "90 days", "never" — how long the key lasted, which "same as before" repeats. */
function lifetime(key: ApiKey): string {
    if (!key.expiresAt) return 'Never expires'
    const days = Math.round((new Date(key.expiresAt).getTime() - new Date(key.createdAt).getTime()) / DAY)
    return `${days} day${days === 1 ? '' : 's'} again`
}

export function RotateKeyDialog({ apiKey, options, resumed, onClose, onDone }: {
    apiKey: ApiKey
    options: ApiKeyOptions
    /** Choices parked before an identity-provider sign-in. */
    resumed?: ApiKeyDraft | null
    onClose: () => void
    /** A new key exists: the list should reload. Called as the dialog closes. */
    onDone: () => void
}) {
    const renew = isRenewable(apiKey)
    const [grace, setGrace] = useState<Grace>(resumed?.grace ?? (renew ? 0 : 86400))
    const [expiry, setExpiry] = useState<ExpiryChoice | 'same'>(resumed?.expiry ?? 'same')
    const [customDate, setCustomDate] = useState(resumed?.customDate ?? '')
    const [password, setPassword] = useState('')
    const [passwordFailed, setPasswordFailed] = useState(false)
    const [refusedStepUp, setRefusedStepUp] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [created, setCreated] = useState<CreatedApiKey | null>(null)
    const [acknowledged, setAcknowledged] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [detail, setDetail] = useState<ApiKeyDetail | null>(null)

    // Renewing: what it would reach today, before deciding.
    useEffect(() => {
        if (!renew) return
        let live = true
        apiKeyService.get(apiKey.id).then((d) => { if (live) setDetail(d) }).catch(() => {})
        return () => { live = false }
    }, [renew, apiKey.id])

    const max = options.policy.maxLifetimeDays
    const stepUpAvailable = options.stepUpAvailable && !refusedStepUp
    const viaProvider = options.stepUp.method === 'sso' && !options.stepUp.fresh
    const dateProblem = expiry === 'custom' ? customDateProblem(customDate, max) : null
    const canSubmit = !busy && stepUpAvailable && dateProblem === null
        && (options.stepUp.method !== 'password' || password.length > 0)
    const verb = renew ? 'Renew' : 'Rotate'

    const requestClose = () => {
        if (confirming) { setConfirming(false); return }
        if (busy) return
        if (created && !acknowledged) { setConfirming(true); return }
        if (created) onDone()
        onClose()
    }

    async function submit() {
        setBusy(true)
        setError(null)
        setPasswordFailed(false)
        try {
            const result = await apiKeyService.rotate(apiKey.id, {
                graceSeconds: renew ? 0 : grace,
                ...(expiry === 'same' ? {} : expiryFields(expiry, customDate)),
                currentPassword: options.stepUp.method === 'password' ? password : undefined,
            })
            setPassword('')
            setCreated(result)
        } catch (err) {
            if (err instanceof ApiKeyError && err.code === 'step_up_required' && err.method === 'sso' && err.loginUrl) {
                parkDraft({
                    ...freshDraft(options, apiKey, renew ? 'renew' : 'rotate'),
                    step: 'review', grace, expiry, customDate,
                })
                window.location.href = err.loginUrl
                return
            }
            if (err instanceof ApiKeyError && err.code === 'step_up_unavailable') {
                setRefusedStepUp(true)
            } else if (err instanceof ApiKeyError && err.code === 'step_up_failed') {
                setPasswordFailed(true)
                setPassword('')
            } else if (err instanceof ApiKeyError && err.code === 'api_key_rotated') {
                setError('This key has already been replaced. Close this and refresh to see the key that replaced it.')
            } else {
                setError(err instanceof Error ? err.message : `The key could not be ${renew ? 'renewed' : 'rotated'}.`)
            }
        } finally {
            setBusy(false)
        }
    }

    return (
        <>
            <KeyDialog
                icon={RotateCw}
                title={created ? 'Copy your new key' : `${verb} “${apiKey.name}”`}
                subtitle={created
                    ? 'This is the only time it will be shown.'
                    : renew
                        ? 'A fresh token for a key that has stopped working.'
                        : 'A new token that can do exactly what this one does.'}
                wide
                onClose={requestClose}
                footer={created ? (
                    <HoverTip label={acknowledged ? 'Close and see it in your list' : 'Tick “I’ve stored it somewhere safe” first'}>
                        <Button variant="primary" leftIcon={Check} disabled={!acknowledged} onClick={requestClose}>
                            Done
                        </Button>
                    </HoverTip>
                ) : (
                    <>
                        <Button variant="ghost" onClick={requestClose}>Cancel</Button>
                        <Button variant="primary" leftIcon={RotateCw} loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
                            {viaProvider ? 'Continue with your identity provider' : `${verb} key`}
                        </Button>
                    </>
                )}
            >
                {created ? (
                    <RevealPanel created={created} acknowledged={acknowledged} onAcknowledge={setAcknowledged} />
                ) : (
                    <div className="space-y-7">
                        {!stepUpAvailable && (
                            <StepUpField stepUp={options.stepUp} available={false} password="" onPasswordChange={() => {}} />
                        )}

                        {apiKey.status === 'paused' && (
                            <p className="flex items-start gap-2.5 p-3.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] text-xs text-ink-secondary leading-relaxed">
                                <PauseCircle className="w-4 h-4 mt-px shrink-0 text-amber-500" aria-hidden />
                                <span>
                                    This key is only paused: signing in through your identity provider again resumes it,
                                    and nothing was revoked. Rotate it only if you want a new token as well.
                                </span>
                            </p>
                        )}

                        {renew ? (
                            <section>
                                <FieldLabel>What it will reach</FieldLabel>
                                <p className="text-xs text-ink-muted mb-3 leading-relaxed">
                                    The renewed key keeps this key’s limits, on your access as it is today.
                                </p>
                                {detail ? <AccessMatrix access={detail.effectiveAccess} /> : <Skeleton className="h-24 rounded-xl" />}
                            </section>
                        ) : (
                            <section>
                                <FieldLabel>When should the old key stop working?</FieldLabel>
                                <div role="radiogroup" aria-label="Old key keeps working" className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                    {GRACE.map((g) => {
                                        const on = grace === g.value
                                        const Icon = g.icon
                                        return (
                                            <button
                                                key={g.value}
                                                type="button"
                                                role="radio"
                                                aria-checked={on}
                                                onClick={() => setGrace(g.value)}
                                                className={cn(
                                                    'p-3 rounded-xl border-2 text-left transition-colors duration-150',
                                                    on ? 'border-indigo-500 bg-indigo-500/[0.07]' : 'border-black/[0.10] dark:border-white/[0.12] hover:border-indigo-500/40',
                                                )}
                                            >
                                                <Icon className={cn('w-4 h-4 mb-1.5', on ? 'text-indigo-500' : 'text-ink-muted')} aria-hidden />
                                                <span className={cn('block text-sm font-semibold', on ? 'text-indigo-600 dark:text-indigo-400' : 'text-ink')}>{g.label}</span>
                                                {' '}
                                                <span className="block text-[11px] text-ink-muted leading-snug mt-0.5">{g.sub}</span>
                                            </button>
                                        )
                                    })}
                                </div>
                                <Timeline graceSeconds={grace} />
                            </section>
                        )}

                        <section>
                            <FieldLabel>How long should the new key last?</FieldLabel>
                            <ExpiryPicker
                                value={expiry}
                                customDate={customDate}
                                onChange={setExpiry}
                                onCustomDate={setCustomDate}
                                maxLifetimeDays={max}
                                same={lifetime(apiKey)}
                                dateProblem={dateProblem}
                            />
                        </section>

                        {stepUpAvailable && (
                            <StepUpField
                                stepUp={options.stepUp}
                                available
                                password={password}
                                onPasswordChange={setPassword}
                                failed={passwordFailed}
                            />
                        )}

                        {error && (
                            <p role="alert" className="flex items-start gap-2 p-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] text-sm text-rose-700 dark:text-rose-300">
                                <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
                                {error}
                            </p>
                        )}
                    </div>
                )}
            </KeyDialog>
            <CloseConfirm
                open={confirming}
                title="Close without storing the key?"
                body="It won’t be shown again. If you haven’t copied it, you would have to rotate the key again."
                keepLabel="Go back"
                leaveLabel="Close anyway"
                onKeep={() => setConfirming(false)}
                onLeave={() => { setConfirming(false); onDone(); onClose() }}
            />
        </>
    )
}

/** Now → the moment the old key stops, in plain words. */
function Timeline({ graceSeconds, now = new Date() }: { graceSeconds: Grace; now?: Date }) {
    const ends = new Date(now.getTime() + graceSeconds * 1000)
    return (
        <div className="mt-4 p-4 rounded-xl bg-black/[0.025] dark:bg-white/[0.03] border border-black/[0.06] dark:border-white/[0.07]">
            <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 ring-4 ring-emerald-500/15 shrink-0" />
                <span className="flex-1 h-0.5 rounded-full bg-gradient-to-r from-emerald-500 to-rose-500 opacity-60" />
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500 ring-4 ring-rose-500/15 shrink-0" />
            </div>
            <div className="mt-2 flex justify-between gap-4 text-[11px]">
                <span className="text-ink-secondary"><span className="font-semibold text-ink">Now</span> — the new key works</span>
                <span className="text-right text-ink-secondary">
                    <span className="font-semibold text-ink">{graceSeconds === 0 ? 'Now' : formatWhen(ends)}</span> — the old key stops
                </span>
            </div>
            <p className="mt-3 text-xs text-ink-secondary leading-relaxed">
                {graceSeconds === 0
                    ? 'Your old key stops working the moment the new one is created. Anything still using it fails until it has the new one.'
                    : `Both work until then: your old key stops working ${formatWhen(ends)}. Swap the new one in everywhere before that.`}
            </p>
        </div>
    )
}
