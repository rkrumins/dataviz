/**
 * What still opens when single sign-on does not.
 *
 * Three cards straight after the two doors, because each answers part of
 * the question the Passwords switch raises: if the identity provider goes
 * down, who can still get in? Whether an outage is happening — and whether
 * anything is watching for one — the door an admin can open for everyone
 * by hand, and the accounts that can always get in to open it.
 *
 * They read the posture the tab already holds rather than fetching their
 * own; the window's two calls answer with the posture, which goes straight
 * back to the tab.
 */
import { useRef, useState } from 'react'
import {
    Activity, AlertTriangle, CheckCircle2, KeyRound, LifeBuoy, Loader2,
    ShieldCheck, XCircle,
} from 'lucide-react'

import { ssoAdminService, type AuthConfig } from '@/services/ssoAdminService'
import { cn } from '@/lib/utils'
import { formatSpan } from '@/lib/smartTime'
import { toUtcDate } from '@/lib/timeAgo'
import { useNow } from '@/lib/useNow'
import { personHref } from '@/components/ui/PersonChip'
import { Segmented } from '@/components/ui/Segmented'
import { useAppNotifications } from '@/components/ui/notifications'
import { TextField } from '../../settings/ui'
import { SsoCard, SsoSectionLabel } from '../../ui/SsoCard'
import { fallbackOpen } from './posture'

type Hours = '1' | '4' | '8' | '24'

const DURATIONS: { value: Hours; label: string }[] = [
    { value: '1', label: '1 hour' },
    { value: '4', label: '4 hours' },
    { value: '8', label: '8 hours' },
    { value: '24', label: '24 hours' },
]

/** The server's own words when it gave any, and a sentence naming the
 *  action when it did not — a failure must never read as an empty box. */
function errText(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback
}

/** "14:02" — with the day ("Wed 09:00") when it is not today: a window
 *  can run past midnight, and an outage can have started before it. */
function clockAt(iso: string | null | undefined, now: number): string {
    const at = toUtcDate(iso)
    if (!at) return '—'
    const today = new Date(now).toDateString() === at.toDateString()
    return at.toLocaleString(undefined, today
        ? { hour: '2-digit', minute: '2-digit' }
        : { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

export function PasswordFallbackSection({
    cfg, onChange,
}: {
    cfg: AuthConfig
    /** The posture the window's calls answer with. */
    onChange: (next: AuthConfig) => void
}) {
    const emergency = useRef<HTMLDivElement>(null)

    return (
        <section className="mt-6">
            <SsoSectionLabel
                icon={LifeBuoy}
                hint="— Who can still get in, and the door you can open."
            >
                If single sign-on goes down
            </SsoSectionLabel>

            <div className="space-y-2.5">
                {cfg.ssoEnabled && cfg.ssoStatus && (
                    <SsoStatusCard
                        cfg={cfg}
                        status={cfg.ssoStatus}
                        // Focus scrolls the card into view, and leaves the
                        // keyboard on its first control.
                        onOpenEmergency={() =>
                            emergency.current?.querySelector('button')?.focus()}
                    />
                )}
                <div ref={emergency}>
                    <EmergencyAccessCard cfg={cfg} onChange={onChange} />
                </div>
                {cfg.breakGlass && (
                    <BreakGlassCard
                        breakGlass={cfg.breakGlass}
                        passwordsOn={cfg.allowLocalLogin}
                    />
                )}
            </div>
        </section>
    )
}

/** An outage is the one state that spends colour. The healthy answer is a
 *  single quiet line, and "nothing is watching" is a fact, not a fault —
 *  it is the normal state with no OIDC or SAML connection. */
function SsoStatusCard({
    cfg, status, onOpenEmergency,
}: {
    cfg: AuthConfig
    status: NonNullable<AuthConfig['ssoStatus']>
    onOpenEmergency: () => void
}) {
    const now = useNow()

    if (status.outage) {
        const down = status.outage.providers
        // Red only while most people are actually stuck.
        const everyone = cfg.allowLocalLogin || fallbackOpen(cfg, now)
        return (
            <SsoCard
                icon={AlertTriangle}
                tone={everyone ? 'warn' : 'danger'}
                title="Single sign-on status"
                blurb={down.length === 1
                    ? `${down[0].displayName} can't be reached right now.`
                    : `${down.length} connections can't be reached right now.`}
            >
                <ul className="space-y-1.5">
                    {down.map(p => (
                        <li
                            key={p.slug}
                            className="px-3 py-2 rounded-xl border border-glass-border bg-canvas-elevated"
                        >
                            <p className="text-xs text-ink">
                                <span className="font-semibold">{p.displayName}</span>
                                <span className="text-ink-muted"> · down since {clockAt(p.since, now)}</span>
                            </p>
                            {p.detail && (
                                <p className="mt-0.5 font-mono text-[10px] text-ink-muted break-words">
                                    {p.detail}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
                <p className="mt-3 text-xs text-ink leading-relaxed">
                    The sign-in page tells people.{' '}
                    {everyone
                        ? 'Anyone can sign in with a password while it is restored.'
                        : 'Super Admins and break-glass accounts can sign in with a ' +
                          'password; everyone else cannot until it recovers — or ' +
                          'until you open emergency access.'}
                </p>
                {!everyone && (
                    <button
                        type="button"
                        onClick={onOpenEmergency}
                        className="mt-2 px-3 py-1.5 rounded-lg border border-glass-border text-xs font-medium text-ink hover:bg-black/5 dark:hover:bg-white/5"
                    >
                        Open emergency access…
                    </button>
                )}
            </SsoCard>
        )
    }

    if (status.stale) {
        return (
            <SsoCard
                icon={Activity}
                title="Single sign-on status"
                blurb={
                    <>
                        Automatic outage detection isn&rsquo;t running — no
                        OIDC or SAML connection is enabled, or the control
                        plane that checks them isn&rsquo;t running. Without
                        it, an outage gives Super Admins no automatic
                        password fallback; emergency access below works
                        either way.
                    </>
                }
            />
        )
    }

    return (
        <SsoCard
            icon={CheckCircle2}
            title="Single sign-on status"
            blurb={`All connections reachable · checked ${clockAt(status.checkedAt, now)}`}
        />
    )
}

/** The one-click door: passwords for everyone, for a few hours. Opening
 *  it is one click on purpose — the moment it is needed, people are
 *  already waiting — and it closes itself whatever happens next. */
function EmergencyAccessCard({
    cfg, onChange,
}: {
    cfg: AuthConfig
    onChange: (next: AuthConfig) => void
}) {
    const now = useNow()
    const [hours, setHours] = useState<Hours>('1')
    const [reason, setReason] = useState('')
    const [busy, setBusy] = useState(false)
    const { notify } = useAppNotifications()

    const until = toUtcDate(cfg.passwordFallbackUntil)
    const open = fallbackOpen(cfg, now)
    const by = cfg.passwordFallbackBy === 'cli'
        ? 'the command line on the server'
        : cfg.passwordFallbackBy

    async function openWindow() {
        setBusy(true)
        try {
            const next = await ssoAdminService.openPasswordFallback(
                Number(hours), reason.trim() || undefined,
            )
            onChange(next)
            setReason('')
            notify('success',
                'Anyone can sign in with a password until '
                + `${clockAt(next.passwordFallbackUntil, Date.now())} — it `
                + 'closes by itself.',
            )
        } catch (err) {
            notify('error', errText(err, 'Could not open emergency password access.'))
        } finally {
            setBusy(false)
        }
    }

    async function closeWindow() {
        setBusy(true)
        try {
            onChange(await ssoAdminService.closePasswordFallback())
            notify('success',
                'Emergency access is closed. Anyone who signed in with a '
                + 'password during it goes back through single sign-on at '
                + 'their next session renewal.',
            )
        } catch (err) {
            notify('error', errText(err, 'Could not close emergency password access.'))
        } finally {
            setBusy(false)
        }
    }

    if (cfg.allowLocalLogin) {
        return (
            <SsoCard
                icon={KeyRound}
                title="Emergency password access"
                blurb="Passwords are on for everyone, so there is nothing to open. This is for when they are off and single sign-on goes down."
            />
        )
    }

    if (open && until) {
        return (
            <SsoCard icon={KeyRound} tone="warn" title="Emergency password access">
                <p className="text-sm font-semibold text-ink">
                    Open until {clockAt(cfg.passwordFallbackUntil, now)}
                    <span className="ml-2 text-xs font-normal text-ink-muted">
                        {/* Whole minutes, rounded down: the shared clock lags
                            by up to a tick, and 4 hours must not read 4 h 01. */}
                        {formatSpan(Math.max(1, Math.floor((until.getTime() - now) / 60_000)) * 60_000)} left
                    </span>
                </p>
                {(by || cfg.passwordFallbackReason) && (
                    <p className="mt-1 text-xs text-ink-secondary">
                        {[
                            by && `Opened by ${by}`,
                            cfg.passwordFallbackReason && `“${cfg.passwordFallbackReason}”`,
                        ].filter(Boolean).join(' — ')}
                    </p>
                )}
                <p className="mt-2 text-[11px] text-ink-muted leading-relaxed">
                    Anyone can sign in with their password. Closing sends
                    them back through single sign-on at their next session
                    renewal — so close it once sign-in works again.
                </p>
                <button
                    type="button"
                    onClick={() => void closeWindow()}
                    disabled={busy}
                    className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-glass-border text-xs font-medium text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                >
                    {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                    Close now
                </button>
            </SsoCard>
        )
    }

    return (
        <SsoCard
            icon={KeyRound}
            title="Emergency password access"
            blurb="For when single sign-on is down and people need to work: anyone can sign in with their password until it closes by itself. Opening and closing are audited."
        >
            <div className="space-y-3">
                <Segmented
                    options={DURATIONS}
                    value={hours}
                    onChange={setHours}
                    label="How long to open it for"
                    size="md"
                />
                <div className="flex flex-wrap gap-2">
                    <div className="flex-1 min-w-[14rem]">
                        <TextField
                            mono={false}
                            value={reason}
                            onChange={e => setReason(e.target.value)}
                            placeholder="Reason (optional) — e.g. Entra outage, INC-1234"
                            aria-label="Reason"
                        />
                    </div>
                    <button
                        type="button"
                        onClick={() => void openWindow()}
                        disabled={busy}
                        className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-500 text-white text-sm font-semibold hover:bg-amber-600 disabled:opacity-50"
                    >
                        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Open for everyone
                    </button>
                </div>
            </div>
        </SsoCard>
    )
}

/** Who can always get in. "Ready" is the server's word — active, a Super
 *  Admin, a password set — and each row says which of those is missing,
 *  because "not ready" alone sends the operator hunting. */
function BreakGlassCard({
    breakGlass, passwordsOn,
}: {
    breakGlass: NonNullable<AuthConfig['breakGlass']>
    passwordsOn: boolean
}) {
    // With passwords on, everyone has a way in; the gap only matters
    // for turning them off.
    const exposed = !breakGlass.ready && !passwordsOn

    return (
        <SsoCard
            icon={ShieldCheck}
            tone={exposed ? 'danger' : 'neutral'}
            title="Break-glass accounts"
            blurb="System accounts keep password sign-in whatever the switches say — at /login?password=1 — and sign-out sweeps skip them. Ready means active, a Super Admin, with a password."
        >
            {!breakGlass.ready && (
                <p className={cn(
                    'mb-3 flex items-start gap-1.5 text-xs leading-relaxed',
                    exposed ? 'text-red-500' : 'text-amber-600 dark:text-amber-400',
                )}>
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    {exposed
                        ? 'No break-glass account is ready — an IdP outage could lock everyone out.'
                        : 'No break-glass account is ready — you will need one before passwords can be turned off.'}
                </p>
            )}

            {breakGlass.accounts.length === 0 ? (
                <p className="text-xs text-ink-secondary">
                    No system accounts yet. Mark an active Super Admin who has
                    a password as a system account.
                </p>
            ) : (
                <ul className="space-y-1.5">
                    {breakGlass.accounts.map(a => (
                        <li
                            key={a.id}
                            className="flex items-center gap-3 px-3 py-2 rounded-xl border border-glass-border bg-canvas-elevated"
                        >
                            {a.ready
                                ? <CheckCircle2 aria-hidden className="w-4 h-4 shrink-0 text-emerald-500" />
                                : <XCircle aria-hidden className="w-4 h-4 shrink-0 text-red-500" />}
                            <div className="min-w-0 flex-1">
                                <a
                                    href={personHref(a.id)}
                                    className="block text-xs font-medium text-ink truncate hover:underline"
                                >
                                    {a.email}
                                </a>
                                <p className="text-[11px] text-ink-muted">
                                    <Fact ok={a.status === 'active'}>
                                        {a.status.charAt(0).toUpperCase() + a.status.slice(1)}
                                    </Fact>
                                    {' · '}
                                    <Fact ok={a.superAdmin}>
                                        {a.superAdmin ? 'Super Admin' : 'not a Super Admin'}
                                    </Fact>
                                    {' · '}
                                    <Fact ok={a.passwordSet}>
                                        {a.passwordSet ? 'password set' : 'no password'}
                                    </Fact>
                                </p>
                            </div>
                            <span className={cn(
                                'shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold',
                                a.ready
                                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                    : 'bg-black/[0.06] dark:bg-white/[0.10] text-ink-muted',
                            )}>
                                {a.ready ? 'Ready' : 'Not ready'}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            <a
                href="/admin/users"
                className="mt-3 inline-block text-[11px] font-medium text-accent-lineage hover:underline"
            >
                Manage accounts in Admin → Users
            </a>
        </SsoCard>
    )
}

/** One readiness fact; the missing one is the one coloured. */
function Fact({ ok, children }: { ok: boolean; children: string }) {
    return (
        <span className={ok ? undefined : 'text-amber-600 dark:text-amber-400'}>
            {children}
        </span>
    )
}
