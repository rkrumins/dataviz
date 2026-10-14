/**
 * Confirming it's you before a key is minted.
 *
 * A key outlives the session that made it, so creating or rotating one asks
 * for proof of a fresh sign-in: your password, or your identity provider.
 * The provider is a round trip away — the dialog's own button parks what you
 * chose and goes there, and you come back to the step you left. Some
 * providers cannot prove a sign-in at all; that is said up front, with who
 * can change it, rather than after a form that was always going to be refused.
 */
import { AlertTriangle, CheckCircle2, Lock, ShieldAlert, ShieldCheck } from 'lucide-react'

import { BigInput, FieldLabel, Hint } from '@/components/admin/InviteWizard/ui'
import type { ApiKeyOptions, StepUpReason } from '@/services/apiKeyService'

/** Why minting is refused when the sign-in cannot be confirmed, by the server's
 *  reason — shared with the page's banner. */
export function stepUpUnavailable(reason?: StepUpReason | null): { title: string; body: string } {
    if (reason === 'system_account') {
        return {
            title: 'A break-glass account holds no keys',
            body: 'This is a break-glass account, kept for when nobody else can sign in, so it can’t have API keys — '
                + 'any it has don’t work while it is one. Make them from your own account.',
        }
    }
    if (reason === 'passwords_off') {
        return {
            title: 'A password can’t confirm it’s you here',
            body: 'Password sign-in is switched off, so keys can’t be created, rotated or renewed with a password. '
                + 'Sign in with single sign-on to manage them.',
        }
    }
    return {
        title: 'This sign-in can’t confirm it’s you',
        body: 'Your sign-in provider can’t confirm a fresh sign-in, so keys can’t be created or rotated from this session. '
            + 'An administrator can allow it under Administration → Features → Authentication.',
    }
}

export function StepUpField({ stepUp, available, reason, password, onPasswordChange, failed }: {
    stepUp: ApiKeyOptions['stepUp']
    available: boolean
    /** Why not, when it is not available. */
    reason?: StepUpReason | null
    password: string
    onPasswordChange: (password: string) => void
    /** The last password was refused. */
    failed?: boolean
}) {
    if (!available) {
        const why = stepUpUnavailable(reason)
        return (
            <Panel tone="danger" icon={ShieldAlert} title={why.title}>
                {why.body}
            </Panel>
        )
    }
    if (stepUp.method === 'password') {
        return (
            <div>
                <FieldLabel>Confirm it’s you</FieldLabel>
                <BigInput
                    type="password"
                    icon={Lock}
                    autoComplete="current-password"
                    aria-label="Your password"
                    placeholder="Your password"
                    state={failed ? 'invalid' : 'idle'}
                    value={password}
                    onChange={(e) => onPasswordChange(e.target.value)}
                />
                {failed ? (
                    <Hint tone="warn">That password isn’t right. Nothing was created.</Hint>
                ) : (
                    <Hint>A key outlives this session, so it takes your password to make one.</Hint>
                )}
            </div>
        )
    }
    if (stepUp.fresh) {
        return (
            <Panel tone="success" icon={CheckCircle2} title="Confirmed">
                You signed in with your identity provider in the last few minutes, so there is nothing more to do.
            </Panel>
        )
    }
    return (
        <Panel tone="info" icon={ShieldCheck} title="Confirm with your identity provider">
            A key outlives this session, so your identity provider confirms it’s you. You’ll sign in
            again and come straight back here — what you chose is kept, and nothing secret is.
        </Panel>
    )
}

const TONES = {
    danger: { box: 'border-rose-500/25 bg-rose-500/[0.06]', icon: 'text-rose-500', title: 'text-rose-700 dark:text-rose-300' },
    success: { box: 'border-emerald-500/25 bg-emerald-500/[0.06]', icon: 'text-emerald-500', title: 'text-emerald-700 dark:text-emerald-300' },
    info: { box: 'border-indigo-500/25 bg-indigo-500/[0.06]', icon: 'text-indigo-500', title: 'text-indigo-700 dark:text-indigo-300' },
}

function Panel({ tone, icon: Icon, title, children }: {
    tone: keyof typeof TONES
    icon: typeof AlertTriangle
    title: string
    children: React.ReactNode
}) {
    const t = TONES[tone]
    return (
        <div className={`flex items-start gap-3 p-4 rounded-2xl border ${t.box}`}>
            <span className="w-9 h-9 rounded-xl bg-canvas-elevated flex items-center justify-center shrink-0 shadow-sm">
                <Icon className={`w-[18px] h-[18px] ${t.icon}`} aria-hidden />
            </span>
            <div className="min-w-0">
                <p className={`text-sm font-semibold ${t.title}`}>{title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-secondary">{children}</p>
            </div>
        </div>
    )
}
