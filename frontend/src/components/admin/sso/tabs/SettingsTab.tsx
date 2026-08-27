/**
 * SettingsTab — the platform-wide sign-in posture.
 *
 * Four booleans, and the page used to render them as four independent
 * rows described in terms of HTTP status codes: "/auth/providers returns
 * []", "POST /auth/login returns 403", "raise jit_disabled". True, and
 * useless to the person deciding — they need to know what a colleague
 * sees, not what the API answers.
 *
 * So the page leads with the *combination* — one sentence describing what
 * happens when somebody opens the sign-in page right now — and groups the
 * switches by the question each answers. The API detail is still here,
 * folded under each row, because it is exactly right for the second reader
 * and exactly wrong for the first.
 *
 * Risks that depend on the rest of the world (no live connection, no email
 * domains, this being the only way in) surface on the row *before* the
 * click, rather than as a 409 afterwards.
 */
import {
    useCallback, useEffect, useMemo, useState, type ReactNode,
} from 'react'
import { motion } from 'framer-motion'
import {
    AlertTriangle, Check, ChevronDown, DoorOpen, Loader2, LogOut, Mail,
    ShieldCheck, UserPlus, X,
} from 'lucide-react'

import {
    ssoAdminService,
    type AuthConfig,
    type IdpProvider,
} from '@/services/ssoAdminService'
import { cn } from '@/lib/utils'
import { ErrorBanner } from './ErrorBanner'
import { BackchannelHostsPanel } from './settings/BackchannelHostsPanel'
import { AvatarHostsPanel } from './settings/AvatarHostsPanel'
import { describePosture, riskChecks, type PostureTone } from './settings/posture'
import { SsoCard, SsoSectionLabel, type CardTone } from '../ui/SsoCard'
import { SsoSettingsSkeleton, SsoLoading } from '../ui/SsoSkeleton'

interface SwitchDef {
    field: keyof AuthConfig
    label: string
    /** What it means for a person, in their terms. */
    summary: string
    /** What changes on the wire. Folded away — right for the second reader. */
    technical: string
    /** Turning it OFF is the restrictive direction and wants a confirm. */
    confirmOff?: boolean
}

const GROUPS: { title: string; blurb: string; icon: typeof DoorOpen; switches: SwitchDef[] }[] = [
    {
        title: 'Who can sign in',
        blurb: 'The two doors. At least one has to stay open.',
        icon: DoorOpen,
        switches: [
            {
                field: 'ssoEnabled',
                label: 'Single sign-on',
                summary:
                    'The master switch for every connection at once. Off, and the ' +
                    'sign-in page shows no company buttons — but nothing is deleted, ' +
                    'and turning it back on restores every connection as it was. ' +
                    'People already signed in stay signed in until their sessions ' +
                    'expire, unless you sign them out when turning this off.',
                technical:
                    '/auth/providers returns [] and every /auth/{slug}/* route ' +
                    'returns 404. Provider rows keep their settings.',
                confirmOff: true,
            },
            {
                field: 'allowLocalLogin',
                label: 'Passwords',
                summary:
                    'Whether anyone can still sign in with an email and password. ' +
                    'Off means single sign-on is the only way in.',
                technical:
                    'POST /auth/login returns 403. Refused with 409 if it would ' +
                    'lock out an active admin who has no SSO identity and is not ' +
                    'a system account. System accounts keep password sign-in, at ' +
                    '/login?password=1.',
                confirmOff: true,
            },
        ],
    },
    {
        title: 'What happens to someone new',
        blurb: 'The first time a person your IdP knows arrives here.',
        icon: UserPlus,
        switches: [
            {
                field: 'allowJitProvisioning',
                label: 'Create accounts automatically',
                summary:
                    'On, an account appears the first time someone signs in through ' +
                    'a connection — no invite needed. Off, they must already exist ' +
                    'here, and an unknown person is turned away.',
                technical:
                    'An unknown subject raises jit_disabled instead of creating a ' +
                    'user. Existing users are unaffected.',
                confirmOff: true,
            },
        ],
    },
    {
        title: 'How the sign-in page asks',
        blurb: 'Only affects presentation — nobody gains or loses access.',
        icon: Mail,
        switches: [
            {
                field: 'emailFirstLogin',
                label: 'Ask for an email first',
                summary:
                    'One field instead of a row of buttons: type an address and we ' +
                    'route to the connection that owns its domain. Better once you ' +
                    'have several connections, and it stops people guessing which ' +
                    'button is theirs.',
                technical:
                    'The login page calls /auth/resolve with the address and ' +
                    'redirects to the matching provider. An address matching nothing ' +
                    'falls back to the password form.',
            },
        ],
    },
]

/** The healthy posture is the common one, so it gets the neutral card and
 *  only a warn/danger state spends colour. As a full-width amber slab this
 *  shouted on every visit and taught operators to stop reading it. */
const POSTURE_TONE: Record<PostureTone, CardTone> = {
    ok: 'neutral', warn: 'warn', danger: 'danger',
}

export function SettingsTab({ providers: seeded }: { providers?: IdpProvider[] }) {
    const [cfg, setCfg] = useState<AuthConfig | null>(null)
    const [providers, setProviders] = useState<IdpProvider[]>(seeded ?? [])
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [pending, setPending] = useState<keyof AuthConfig | null>(null)
    const [confirming, setConfirming] = useState<keyof AuthConfig | null>(null)
    // The ssoEnabled confirm carries a number: how many people are signed
    // in through a connection right now, and whether to sign them out
    // too. ``null`` = count unavailable (the confirm happens anyway).
    const [ssoOffCount, setSsoOffCount] = useState<number | null>(null)
    const [ssoOffSignOut, setSsoOffSignOut] = useState(false)
    // The allowLocalLogin confirm asks the same question about EVERY
    // session: enforcement changes what the next sign-in must be, and
    // the sessions already out there stay valid under the old policy
    // until they expire. ``null`` = counts unavailable.
    const [localOffDry, setLocalOffDry] = useState<
        { affected: number; skipped: number } | null
    >(null)
    const [localOffSignOut, setLocalOffSignOut] = useState(false)

    const refresh = useCallback(async () => {
        try {
            setCfg(await ssoAdminService.getAuthConfig())
            setError(null)
        } catch (err) {
            setError((err as Error).message)
        }
        // The posture sentence needs to know what is actually live. A
        // failure here costs the sentence its detail, not the page.
        try {
            setProviders(await ssoAdminService.listProviders())
        } catch {
            setProviders([])
        }
    }, [])

    useEffect(() => { void refresh() }, [refresh])

    const posture = useMemo(
        () => describePosture(cfg, providers), [cfg, providers],
    )
    const risks = useMemo(
        () => riskChecks(cfg, providers), [cfg, providers],
    )

    async function apply(field: keyof AuthConfig, value: boolean): Promise<boolean> {
        if (!cfg) return false
        setPending(field)
        try {
            setCfg(await ssoAdminService.updateAuthConfig({
                [field]: value, expectedVersion: cfg.version,
            } as never))
            setError(null)
            return true
        } catch (err) {
            setError((err as Error).message)
            return false
        } finally {
            setPending(null)
            setConfirming(null)
        }
    }

    /** Best-effort count for the ssoEnabled confirm. Losing the number
     *  must not lose the confirm. */
    async function loadSsoOffCount() {
        setSsoOffCount(null)
        setSsoOffSignOut(false)
        try {
            const dry = await ssoAdminService.endSsoSessions({ dryRun: true })
            setSsoOffCount(dry.usersAffected)
        } catch {
            setSsoOffCount(null)
        }
    }

    async function confirmSsoOff() {
        const signOut = ssoOffSignOut
        const ok = await apply('ssoEnabled', false)
        if (!ok || !signOut) return
        try {
            const ended = await ssoAdminService.endSsoSessions()
            setNotice(
                `Signed out ${ended.usersAffected} ${
                    ended.usersAffected === 1 ? 'person' : 'people'
                } who had signed in through a connection.`,
            )
        } catch (err) {
            // The switch DID flip — say so, and say what didn't happen.
            setError(
                'Single sign-on is off, but signing its users out failed: '
                + (err as Error).message,
            )
        }
    }

    /** Best-effort counts for the allowLocalLogin confirm — same rule as
     *  ``loadSsoOffCount``: losing the numbers must not lose the confirm. */
    async function loadLocalOffCounts() {
        setLocalOffDry(null)
        setLocalOffSignOut(false)
        try {
            const dry = await ssoAdminService.endAllSessions({ dryRun: true })
            setLocalOffDry({
                affected: dry.usersAffected,
                skipped: dry.systemAccountsSkipped,
            })
        } catch {
            setLocalOffDry(null)
        }
    }

    async function confirmLocalOff() {
        const signOut = localOffSignOut
        const ok = await apply('allowLocalLogin', false)
        if (!ok || !signOut) return
        try {
            const ended = await ssoAdminService.endAllSessions()
            setNotice(
                `Signed out ${ended.usersAffected} ${
                    ended.usersAffected === 1 ? 'person' : 'people'
                } — everyone signs back in under single sign-on. If your own `
                + 'session was among them, you will be taken to the sign-in '
                + 'page in a moment.',
            )
        } catch (err) {
            setError(
                'Passwords are off, but the sign-everyone-out failed: '
                + (err as Error).message,
            )
        }
    }

    if (cfg === null && error === null) {
        return (
            <div className="grid xl:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
                <div className="min-w-0">
                    <SsoLoading label="Reading the current sign-in posture" />
                    <SsoSettingsSkeleton />
                </div>
            </div>
        )
    }

    return (
        <div className="grid xl:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
            <div className="min-w-0 space-y-6">
            {error && <ErrorBanner message={error} />}
            {notice && (
                <div
                    role="status"
                    className="flex items-start gap-2 px-3 py-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06]"
                >
                    <Check className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" />
                    <p className="text-xs text-ink flex-1 min-w-0">{notice}</p>
                    <button
                        type="button"
                        aria-label="Dismiss notice"
                        onClick={() => setNotice(null)}
                        className="shrink-0 text-ink-muted hover:text-ink"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {GROUPS.map((group, gi) => (
                <motion.section
                    key={group.title}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.16, delay: 0.05 + gi * 0.05 }}
                >
                    <SsoSectionLabel icon={group.icon} hint={`— ${group.blurb}`}>
                        {group.title}
                    </SsoSectionLabel>

                    <div className="space-y-2.5">
                        {group.switches.map(s => (
                            <SwitchRow
                                key={String(s.field)}
                                def={s}
                                value={Boolean(cfg?.[s.field])}
                                risk={risks.find(r => r.field === s.field)}
                                pending={pending === s.field}
                                disabled={pending !== null || cfg === null}
                                confirming={confirming === s.field}
                                confirmExtra={
                                    s.field === 'ssoEnabled' ? (
                                        <SignOutSsoUsersChoice
                                            count={ssoOffCount}
                                            checked={ssoOffSignOut}
                                            onChange={setSsoOffSignOut}
                                        />
                                    ) : s.field === 'allowLocalLogin' ? (
                                        <RequireReloginChoice
                                            dry={localOffDry}
                                            checked={localOffSignOut}
                                            onChange={setLocalOffSignOut}
                                        />
                                    ) : undefined
                                }
                                onRequest={next => {
                                    if (s.confirmOff && !next) {
                                        setConfirming(s.field)
                                        if (s.field === 'ssoEnabled') {
                                            void loadSsoOffCount()
                                        }
                                        if (s.field === 'allowLocalLogin') {
                                            void loadLocalOffCounts()
                                        }
                                    } else void apply(s.field, next)
                                }}
                                onConfirm={() => {
                                    if (s.field === 'ssoEnabled') void confirmSsoOff()
                                    else if (s.field === 'allowLocalLogin') {
                                        void confirmLocalOff()
                                    }
                                    else void apply(s.field, false)
                                }}
                                onCancel={() => setConfirming(null)}
                            />
                        ))}
                    </div>
                </motion.section>
            ))}

            {/* Sessions outlive the switch, so the switch alone is not the
                whole act of turning SSO off. This is the second half,
                standing alone for the operator who declined it at confirm
                time (or turned SSO off before the offer existed). */}
            {cfg !== null && !cfg.ssoEnabled && (
                <EndSsoSessionsCard
                    onDone={line => { setNotice(line); setError(null) }}
                    onError={msg => setError(msg)}
                />
            )}

            {/* The admin-level "everyone signs in again" — for a posture
                change already made (enforcement flipped earlier, a
                suspected leak, an IdP migration). Always present: the
                moment it is needed is rarely the moment a switch is
                being flipped. */}
            {cfg !== null && (
                <EndAllSessionsCard
                    onDone={line => { setNotice(line); setError(null) }}
                    onError={msg => setError(msg)}
                />
            )}

            {/* Not one of the four switches, but the same kind of decision:
                a platform-wide posture that decides what sign-in can
                reach. It belongs beside them rather than inside one
                provider's settings, where it would be circular. */}
            <BackchannelHostsPanel />

            <AvatarHostsPanel />

            <p className="text-[11px] text-ink-muted">
                Version {cfg?.version ?? '—'} · last changed {relative(cfg?.updatedAt)}
            </p>
            </div>

            {/* Sticky, because it is the consequence of the switches beside
                it. At the top of the page it scrolled away exactly when the
                operator started flipping things and needed to watch it. */}
            <aside className="xl:sticky xl:top-6">
                <SsoCard
                    icon={posture.tone === 'ok' ? ShieldCheck : AlertTriangle}
                    tone={POSTURE_TONE[posture.tone]}
                >
                    <h2 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                        Right now, at the sign-in page
                    </h2>
                    <p className="mt-1.5 text-sm font-semibold text-ink leading-snug">
                        {posture.headline}
                    </p>
                    {posture.notes.length > 0 && (
                        <ul className="mt-3 space-y-1.5 pt-3 border-t border-glass-border">
                            {posture.notes.map(n => (
                                <li key={n} className="text-[11px] text-ink-secondary leading-relaxed">
                                    {n}
                                </li>
                            ))}
                        </ul>
                    )}
                </SsoCard>
            </aside>
        </div>
    )
}

function SwitchRow({
    def, value, risk, pending, disabled, confirming, confirmExtra,
    onRequest, onConfirm, onCancel,
}: {
    def: SwitchDef
    value: boolean
    risk?: { tone: PostureTone; message: string }
    pending: boolean
    disabled: boolean
    confirming: boolean
    /** Extra content for the confirm block — a choice that rides along
     *  with the "turn it off", like the sign-everyone-out checkbox. */
    confirmExtra?: ReactNode
    onRequest: (next: boolean) => void
    onConfirm: () => void
    onCancel: () => void
}) {
    const [showTechnical, setShowTechnical] = useState(false)
    // Only worth showing against the state it is a risk *of*. A warning
    // about turning something off is noise while it is already off.
    const showRisk = risk && value

    return (
        <div className={cn(
            'rounded-xl border p-4 transition-colors duration-150',
            confirming
                ? 'border-red-500/40 bg-red-500/[0.05]'
                : 'border-glass-border bg-canvas-elevated',
        )}>
            <div className="flex items-start gap-3.5">
                <button
                    type="button"
                    role="switch"
                    aria-checked={value}
                    aria-label={def.label}
                    disabled={disabled}
                    onClick={() => onRequest(!value)}
                    className={cn(
                        'mt-0.5 shrink-0 relative w-11 h-6 rounded-full transition-colors duration-150 disabled:opacity-50',
                        value ? 'bg-emerald-500' : 'bg-black/15 dark:bg-white/20',
                    )}
                >
                    <motion.span
                        layout
                        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                        className={cn(
                            'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow flex items-center justify-center',
                            value ? 'left-[1.375rem]' : 'left-0.5',
                        )}
                    >
                        {pending && <Loader2 className="w-3 h-3 animate-spin text-ink-muted" />}
                    </motion.span>
                </button>

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-ink">{def.label}</span>
                        <span className={cn(
                            'px-1.5 py-0.5 rounded text-[10px] font-semibold',
                            value
                                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                : 'bg-black/[0.06] dark:bg-white/[0.10] text-ink-muted',
                        )}>
                            {value ? 'ON' : 'OFF'}
                        </span>
                    </div>

                    <p className="mt-1 text-xs text-ink-secondary leading-relaxed">
                        {def.summary}
                    </p>

                    {showRisk && (
                        <p className={cn(
                            'mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed',
                            risk.tone === 'danger'
                                ? 'text-red-500'
                                : 'text-amber-600 dark:text-amber-400',
                        )}>
                            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                            {risk.message}
                        </p>
                    )}

                    <button
                        type="button"
                        onClick={() => setShowTechnical(t => !t)}
                        aria-expanded={showTechnical}
                        className="mt-2 inline-flex items-center gap-1 text-[10px] text-ink-muted hover:text-ink"
                    >
                        <ChevronDown className={cn(
                            'w-3 h-3 transition-transform duration-150',
                            showTechnical && 'rotate-180',
                        )} />
                        What changes technically
                    </button>
                    {showTechnical && (
                        <p className="mt-1 text-[10px] font-mono text-ink-muted leading-relaxed">
                            {def.technical}
                        </p>
                    )}

                    {confirming && (
                        <div className="mt-3 pt-3 border-t border-red-500/30">
                            <p className="text-xs text-ink">
                                Turn <strong>{def.label}</strong> off?
                                {risk?.tone === 'danger' && ` ${risk.message}`}
                            </p>
                            {confirmExtra}
                            <div className="mt-2 flex gap-2">
                                <button
                                    onClick={onConfirm}
                                    disabled={pending}
                                    className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 disabled:opacity-50"
                                >
                                    Turn it off
                                </button>
                                <button
                                    onClick={onCancel}
                                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                                >
                                    Keep it on
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {value && !pending && !confirming && (
                    <Check className="w-4 h-4 mt-1 shrink-0 text-emerald-500/60" />
                )}
            </div>
        </div>
    )
}

/** The sign-everyone-out choice inside the ssoEnabled confirm. A count
 *  of 0 renders as a statement — there is nobody to offer to sign out. */
function SignOutSsoUsersChoice({
    count, checked, onChange,
}: {
    count: number | null
    checked: boolean
    onChange: (next: boolean) => void
}) {
    if (count === 0) {
        return (
            <p className="mt-2 text-xs text-ink-secondary">
                Nobody is signed in through a connection right now.
            </p>
        )
    }
    return (
        <label className="mt-2 flex items-center gap-2 text-xs text-ink">
            <input
                type="checkbox"
                checked={checked}
                onChange={e => onChange(e.target.checked)}
            />
            {count === null
                ? 'Also sign out everyone who signed in through a connection'
                : `Also sign out the ${count} ${
                    count === 1 ? 'person' : 'people'
                } signed in through a connection`}
        </label>
    )
}

/** The require-everyone-to-sign-in-again choice inside the passwords-off
 *  confirm. Counts of 0 render as statements, and the "including you"
 *  warning is the one line that must never be lost to a failed count. */
function RequireReloginChoice({
    dry, checked, onChange,
}: {
    dry: { affected: number; skipped: number } | null
    checked: boolean
    onChange: (next: boolean) => void
}) {
    if (dry !== null && dry.affected === 0) {
        return (
            <p className="mt-2 text-xs text-ink-secondary">
                Nobody is signed in right now, so there is nothing to end.
            </p>
        )
    }
    return (
        <div className="mt-2">
            <label className="flex items-center gap-2 text-xs text-ink">
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={e => onChange(e.target.checked)}
                />
                {dry === null
                    ? 'Also require everyone to sign in again now'
                    : `Also require the ${dry.affected} ${
                        dry.affected === 1 ? 'person' : 'people'
                    } signed in right now to sign in again`}
            </label>
            <p className="mt-1 text-[11px] text-ink-muted leading-relaxed">
                That includes you, unless your account is a system account
                {dry !== null && dry.skipped > 0
                    ? ` — ${dry.skipped} system ${
                        dry.skipped === 1 ? 'account stays' : 'accounts stay'
                    } signed in.`
                    : '.'}
            </p>
        </div>
    )
}

/** Standalone sign-out for sessions that outlived the master switch.
 *  Two steps on purpose: the first click only fetches the count, and the
 *  irreversible act is behind a second click that carries the number. */
function EndSsoSessionsCard({
    onDone, onError,
}: {
    onDone: (line: string) => void
    onError: (msg: string) => void
}) {
    const [count, setCount] = useState<number | null>(null)
    const [asked, setAsked] = useState(false)
    const [busy, setBusy] = useState(false)

    async function askCount() {
        setBusy(true)
        try {
            const dry = await ssoAdminService.endSsoSessions({ dryRun: true })
            setCount(dry.usersAffected)
            setAsked(true)
        } catch (err) {
            onError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    async function end() {
        setBusy(true)
        try {
            const ended = await ssoAdminService.endSsoSessions()
            onDone(
                `Signed out ${ended.usersAffected} ${
                    ended.usersAffected === 1 ? 'person' : 'people'
                } who had signed in through a connection.`,
            )
            setAsked(false)
        } catch (err) {
            onError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="rounded-xl border border-glass-border bg-canvas-elevated p-4">
            <div className="flex items-start gap-3.5">
                <LogOut className="w-4 h-4 mt-0.5 shrink-0 text-ink-muted" />
                <div className="min-w-0 flex-1">
                    <span className="text-sm font-semibold text-ink">
                        Sessions that outlived the switch
                    </span>
                    <p className="mt-1 text-xs text-ink-secondary leading-relaxed">
                        Turning single sign-on off stops new sign-ins, but people
                        already signed in through a connection keep their sessions
                        until those expire. Password sessions are never touched.
                    </p>
                    {!asked ? (
                        <button
                            type="button"
                            onClick={() => void askCount()}
                            disabled={busy}
                            className="mt-2 px-3 py-1.5 rounded-lg border border-glass-border text-xs font-medium text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                        >
                            Sign them out now…
                        </button>
                    ) : count === 0 ? (
                        <p className="mt-2 text-xs text-ink-secondary">
                            Nobody is still signed in through a connection.
                        </p>
                    ) : (
                        <div className="mt-2">
                            <p className="text-xs text-ink">
                                This signs out {count}{' '}
                                {count === 1 ? 'person' : 'people'} now.
                            </p>
                            <div className="mt-2 flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => void end()}
                                    disabled={busy}
                                    className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 disabled:opacity-50"
                                >
                                    Sign out {count} {count === 1 ? 'person' : 'people'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setAsked(false)}
                                    disabled={busy}
                                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                                >
                                    Never mind
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

/** "Require everyone to sign in again" — the platform-wide sweep.
 *  Same two-step shape as ``EndSsoSessionsCard``: the first click only
 *  fetches the counts, the act is behind a second click carrying them.
 *  Ends password AND SSO sessions; system accounts are skipped, and the
 *  caller's own session is included unless it is one — after which the
 *  app's session-loss recovery walks them to the sign-in page. */
function EndAllSessionsCard({
    onDone, onError,
}: {
    onDone: (line: string) => void
    onError: (msg: string) => void
}) {
    const [dry, setDry] = useState<
        { affected: number; skipped: number } | null
    >(null)
    const [asked, setAsked] = useState(false)
    const [busy, setBusy] = useState(false)

    async function askCounts() {
        setBusy(true)
        try {
            const d = await ssoAdminService.endAllSessions({ dryRun: true })
            setDry({
                affected: d.usersAffected,
                skipped: d.systemAccountsSkipped,
            })
            setAsked(true)
        } catch (err) {
            onError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    async function end() {
        setBusy(true)
        try {
            const ended = await ssoAdminService.endAllSessions()
            onDone(
                `Signed out ${ended.usersAffected} ${
                    ended.usersAffected === 1 ? 'person' : 'people'
                } — everyone signs back in under the current policy. If your `
                + 'own session was among them, you will be taken to the '
                + 'sign-in page in a moment.',
            )
            setAsked(false)
        } catch (err) {
            onError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="rounded-xl border border-glass-border bg-canvas-elevated p-4">
            <div className="flex items-start gap-3.5">
                <LogOut className="w-4 h-4 mt-0.5 shrink-0 text-ink-muted" />
                <div className="min-w-0 flex-1">
                    <span className="text-sm font-semibold text-ink">
                        Require everyone to sign in again
                    </span>
                    <p className="mt-1 text-xs text-ink-secondary leading-relaxed">
                        Ends every session — password and single sign-on alike —
                        so everyone comes back in under whatever the switches
                        above now allow. System accounts are skipped. Your own
                        session is included unless your account is one.
                    </p>
                    {!asked ? (
                        <button
                            type="button"
                            onClick={() => void askCounts()}
                            disabled={busy}
                            className="mt-2 px-3 py-1.5 rounded-lg border border-glass-border text-xs font-medium text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                        >
                            Sign everyone out now…
                        </button>
                    ) : dry !== null && dry.affected === 0 ? (
                        <p className="mt-2 text-xs text-ink-secondary">
                            Nobody is signed in right now.
                        </p>
                    ) : (
                        <div className="mt-2">
                            <p className="text-xs text-ink">
                                This signs out {dry?.affected}{' '}
                                {dry?.affected === 1 ? 'person' : 'people'} now
                                {dry !== null && dry.skipped > 0
                                    ? `; ${dry.skipped} system ${
                                        dry.skipped === 1
                                            ? 'account stays'
                                            : 'accounts stay'
                                    } signed in`
                                    : ''}.
                            </p>
                            <div className="mt-2 flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => void end()}
                                    disabled={busy}
                                    className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 disabled:opacity-50"
                                >
                                    Sign out {dry?.affected}{' '}
                                    {dry?.affected === 1 ? 'person' : 'people'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setAsked(false)}
                                    disabled={busy}
                                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                                >
                                    Never mind
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

/** An ISO timestamp is not an answer to "when did this last change". */
function relative(iso?: string): string {
    if (!iso) return 'never'
    const then = Date.parse(iso)
    if (Number.isNaN(then)) return 'unknown'
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
    const hours = Math.round(mins / 60)
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
    const days = Math.round(hours / 24)
    return `${days} day${days === 1 ? '' : 's'} ago`
}
