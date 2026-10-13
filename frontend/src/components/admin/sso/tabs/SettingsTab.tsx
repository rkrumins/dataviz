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
    ShieldCheck, UserPlus,
} from 'lucide-react'

import {
    ssoAdminService,
    type AuthConfig,
    type AuthConfigPatch,
    type IdpProvider,
    type SsoAdminRequestError,
} from '@/services/ssoAdminService'
import { adminUserService } from '@/services/adminUserService'
import { cn } from '@/lib/utils'
import { useNow } from '@/lib/useNow'
import { useAppNotifications } from '@/components/ui/notifications'
import { ErrorBanner } from './ErrorBanner'
import { BackchannelHostsPanel } from './settings/BackchannelHostsPanel'
import { AvatarHostsPanel } from './settings/AvatarHostsPanel'
import { PasswordFallbackSection } from './settings/FallbackCards'
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
    /** What just happened, in the operator's terms. A switch that moves
     *  says what the sign-in page now does; the switch position alone is
     *  the state, not the answer. */
    resultOn: string
    resultOff: string
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
                resultOn:
                    'Single sign-on is on — your published connections are ' +
                    'back on the sign-in page.',
                resultOff:
                    'Single sign-on is off — no connection signs anyone in ' +
                    'now, and nothing was deleted.',
            },
            {
                field: 'allowLocalLogin',
                label: 'Passwords',
                summary:
                    'On, anyone can fall back to a password. Off, break-glass ' +
                    'accounts only — everyone else signs in through single ' +
                    'sign-on, and if it goes down you can open passwords to ' +
                    'everyone for a few hours.',
                technical:
                    'POST /auth/login answers anyone not allowed a password with ' +
                    'the same 401 as a wrong one. Break-glass (system) accounts ' +
                    'sign in at /login?password=1; Super Admins with a password ' +
                    'can too during a detected outage, and everyone can while an ' +
                    'emergency window is open. Refused with 409 unless a ' +
                    'break-glass account is ready; administrators (Super Admins ' +
                    'and org admins) without an SSO identity are listed for you ' +
                    'to acknowledge first.',
                confirmOff: true,
                resultOn:
                    'Passwords are on — anyone can fall back to a password again.',
                resultOff:
                    'Passwords are off — break-glass accounts only; everyone ' +
                    'else signs in through single sign-on.',
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
                resultOn:
                    'Accounts are created automatically — someone your ' +
                    'directory knows can sign in without an invite.',
                resultOff:
                    'Accounts are no longer created automatically — anyone ' +
                    'not already here is turned away.',
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
                    'goes to the primary connection — the first in login-page order.',
                resultOn:
                    'The sign-in page asks for an email address first.',
                resultOff:
                    'The sign-in page shows the connection buttons again.',
            },
        ],
    },
]

/** Every switch by the field it writes — ``apply`` is handed a field, not
 *  the group the switch happens to sit in. */
const SWITCH: Record<string, SwitchDef> = Object.fromEntries(
    GROUPS.flatMap(g => g.switches).map(s => [s.field, s]),
)

/** The server's own words when it gave any, and a sentence naming the
 *  action when it did not — a failure must never read as an empty box. */
function errText(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback
}

type AdminWithoutSso = { id: string; email: string; role?: 'super_admin' | 'org_admin' }

/** The two refusals the passwords-off confirm answers in place, because
 *  what to do next belongs beside the switch rather than in a toast:
 *  nobody is ready to break the glass, or some administrators could not
 *  sign in at all — a warning the operator may acknowledge. */
type PasswordsOffRefusal =
    | { error: 'no_break_glass_account' }
    | { error: 'would_lock_out_admin'; admins: AdminWithoutSso[] }

function passwordsOffRefusal(err: unknown): PasswordsOffRefusal | null {
    const detail = (err as Partial<SsoAdminRequestError> | null)?.detail as
        { error?: string; adminsWithoutSso?: AdminWithoutSso[] } | undefined
    if (detail?.error === 'no_break_glass_account') return { error: detail.error }
    if (detail?.error === 'would_lock_out_admin') {
        return { error: detail.error, admins: detail.adminsWithoutSso ?? [] }
    }
    return null
}

/** The healthy posture is the common one, so it gets the neutral card and
 *  only a warn/danger state spends colour. As a full-width amber slab this
 *  shouted on every visit and taught operators to stop reading it. */
const POSTURE_TONE: Record<PostureTone, CardTone> = {
    ok: 'neutral', warn: 'warn', danger: 'danger',
}

export function SettingsTab({ providers: seeded }: { providers?: IdpProvider[] }) {
    const [cfg, setCfg] = useState<AuthConfig | null>(null)
    const [providers, setProviders] = useState<IdpProvider[]>(seeded ?? [])
    // Only the posture read writes this. What an operator DOES here — a
    // switch flipped, sessions ended, and every way those fail — just
    // happened, and goes to the app's one notification stack; the banner
    // is for what is still true while it is being read.
    const [error, setError] = useState<string | null>(null)
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
    const [localOffRefusal, setLocalOffRefusal] = useState<PasswordsOffRefusal | null>(null)
    // The admin whose "Make break-glass" is in flight.
    const [marking, setMarking] = useState<string | null>(null)
    const { notify } = useAppNotifications()
    // The posture says whether the emergency window is open, and the
    // window closes by itself.
    const now = useNow()

    const refresh = useCallback(async () => {
        try {
            setCfg(await ssoAdminService.getAuthConfig())
            setError(null)
        } catch (err) {
            setError(errText(
                err, 'The current sign-in posture could not be read.',
            ))
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
        () => describePosture(cfg, providers, now), [cfg, providers, now],
    )
    const risks = useMemo(
        () => riskChecks(cfg, providers), [cfg, providers],
    )

    async function apply(
        field: keyof AuthConfig, value: boolean, extra?: AuthConfigPatch,
    ): Promise<boolean> {
        if (!cfg) return false
        const def = SWITCH[field]
        setPending(field)
        try {
            setCfg(await ssoAdminService.updateAuthConfig({
                [field]: value, expectedVersion: cfg.version, ...extra,
            } as never))
            setError(null)
            notify('success', value ? def.resultOn : def.resultOff)
            setConfirming(null)
            return true
        } catch (err) {
            // A refusal with a way forward keeps the confirm open and
            // says what it is; anything else is a failure like any other.
            const refusal = field === 'allowLocalLogin' ? passwordsOffRefusal(err) : null
            if (refusal) {
                setLocalOffRefusal(refusal)
            } else {
                notify('error', errText(
                    err, `Could not turn ${def.label} ${value ? 'on' : 'off'}.`,
                ))
                setConfirming(null)
            }
            return false
        } finally {
            setPending(null)
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
            notify('success',
                `Signed out ${ended.usersAffected} ${
                    ended.usersAffected === 1 ? 'person' : 'people'
                } who had signed in through a connection.`,
            )
        } catch (err) {
            // The switch DID flip — say so, and say what didn't happen.
            notify('error',
                'Single sign-on is off, but signing its users out failed: '
                + errText(err, 'the request did not complete'),
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

    /** ``acknowledge`` answers the admins-without-SSO warning: the
     *  operator saw the list and turns passwords off anyway. */
    async function confirmLocalOff(acknowledge = false) {
        const signOut = localOffSignOut
        const ok = await apply('allowLocalLogin', false,
            acknowledge ? { acknowledgeAdminsWithoutSso: true } : undefined)
        if (!ok || !signOut) return
        try {
            const ended = await ssoAdminService.endAllSessions()
            notify('success',
                `Signed out ${ended.usersAffected} ${
                    ended.usersAffected === 1 ? 'person' : 'people'
                } — everyone signs back in under single sign-on. If your own `
                + 'session was among them, you will be taken to the sign-in '
                + 'page in a moment.',
            )
        } catch (err) {
            notify('error',
                'Passwords are off, but the sign-everyone-out failed: '
                + errText(err, 'the request did not complete'),
            )
        }
    }

    /** One row of the admins-without-SSO warning, answered: the admin
     *  keeps password sign-in as a break-glass account. Once nobody is
     *  left on the list, the switch is tried again — that is what the
     *  operator asked for. */
    async function makeBreakGlass(admin: AdminWithoutSso) {
        if (localOffRefusal?.error !== 'would_lock_out_admin') return
        setMarking(admin.id)
        try {
            await adminUserService.setSystemAccount(admin.id, true)
        } catch (err) {
            notify('error', errText(
                err, `Could not make ${admin.email} a break-glass account.`,
            ))
            return
        } finally {
            setMarking(null)
        }
        notify('success',
            `${admin.email} is a break-glass account — it keeps password `
            + 'sign-in whatever this switch says.',
        )
        const left = localOffRefusal.admins.filter(a => a.id !== admin.id)
        if (left.length) {
            setLocalOffRefusal({ error: 'would_lock_out_admin', admins: left })
            // The break-glass card below gains the account.
            void refresh()
        } else {
            void confirmLocalOff()
        }
    }

    // The passwords-off confirm's button follows what the server said: an
    // acknowledgement once the admins are listed, and nothing to press
    // until a break-glass account is ready.
    const localOffLabel = localOffRefusal?.error === 'would_lock_out_admin'
        ? 'Turn off anyway'
        : localOffRefusal ? null : undefined

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
                                confirmLabel={
                                    s.field === 'allowLocalLogin' ? localOffLabel : undefined
                                }
                                confirmExtra={
                                    s.field === 'ssoEnabled' ? (
                                        <SignOutSsoUsersChoice
                                            count={ssoOffCount}
                                            checked={ssoOffSignOut}
                                            onChange={setSsoOffSignOut}
                                        />
                                    ) : s.field === 'allowLocalLogin' ? (
                                        localOffRefusal?.error === 'no_break_glass_account' ? (
                                            <NoBreakGlassGuidance />
                                        ) : (
                                            <>
                                                {localOffRefusal && (
                                                    <AdminsWithoutSso
                                                        admins={localOffRefusal.admins}
                                                        marking={marking}
                                                        onMake={a => void makeBreakGlass(a)}
                                                    />
                                                )}
                                                <RequireReloginChoice
                                                    dry={localOffDry}
                                                    checked={localOffSignOut}
                                                    onChange={setLocalOffSignOut}
                                                />
                                            </>
                                        )
                                    ) : undefined
                                }
                                onRequest={next => {
                                    if (s.confirmOff && !next) {
                                        setConfirming(s.field)
                                        if (s.field === 'ssoEnabled') {
                                            void loadSsoOffCount()
                                        }
                                        if (s.field === 'allowLocalLogin') {
                                            setLocalOffRefusal(null)
                                            void loadLocalOffCounts()
                                        }
                                    } else void apply(s.field, next)
                                }}
                                onConfirm={() => {
                                    if (s.field === 'ssoEnabled') void confirmSsoOff()
                                    else if (s.field === 'allowLocalLogin') {
                                        // Reached with the list on screen, the
                                        // click is the acknowledgement.
                                        void confirmLocalOff(
                                            localOffRefusal?.error === 'would_lock_out_admin',
                                        )
                                    }
                                    else void apply(s.field, false)
                                }}
                                onCancel={() => setConfirming(null)}
                            />
                        ))}
                    </div>

                    {/* Straight after the doors: what still opens when the
                        SSO door fails, and the one an admin opens by hand. */}
                    {gi === 0 && cfg !== null && (
                        <PasswordFallbackSection cfg={cfg} onChange={setCfg} />
                    )}
                </motion.section>
            ))}

            {/* Sessions outlive the switch, so the switch alone is not the
                whole act of turning SSO off. This is the second half,
                standing alone for the operator who declined it at confirm
                time (or turned SSO off before the offer existed). */}
            {cfg !== null && !cfg.ssoEnabled && (
                <EndSsoSessionsCard
                    onDone={line => notify('success', line)}
                    onError={msg => notify('error', msg)}
                />
            )}

            {/* The admin-level "everyone signs in again" — for a posture
                change already made (enforcement flipped earlier, a
                suspected leak, an IdP migration). Always present: the
                moment it is needed is rarely the moment a switch is
                being flipped. */}
            {cfg !== null && (
                <EndAllSessionsCard
                    onDone={line => notify('success', line)}
                    onError={msg => notify('error', msg)}
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
    confirmLabel = 'Turn it off', onRequest, onConfirm, onCancel,
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
    /** The confirm button's words; ``null`` when there is nothing to
     *  confirm yet and the extra content says what has to happen first. */
    confirmLabel?: string | null
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
                                {risk?.tone === 'danger' && confirmLabel !== null && ` ${risk.message}`}
                            </p>
                            {confirmExtra}
                            <div className="mt-2 flex gap-2">
                                {confirmLabel !== null && (
                                    <button
                                        onClick={onConfirm}
                                        disabled={pending}
                                        className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 disabled:opacity-50"
                                    >
                                        {confirmLabel}
                                    </button>
                                )}
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

/** The would-be-stranded administrators, inside the passwords-off confirm:
 *  no SSO identity, not break-glass — off, they could not sign in at all.
 *  Each can be made break-glass on the spot; "Turn off anyway" below is
 *  the acknowledgement for the rest. */
function AdminsWithoutSso({
    admins, marking, onMake,
}: {
    admins: AdminWithoutSso[]
    marking: string | null
    onMake: (admin: AdminWithoutSso) => void
}) {
    return (
        <div className="mt-2">
            <p className="text-xs text-ink leading-relaxed">
                {admins.length === 1
                    ? 'This administrator has no single sign-on identity and ' +
                      'is not a break-glass account, so with passwords off ' +
                      'they could not sign in until one is linked.'
                    : `These ${admins.length} administrators have no single ` +
                      'sign-on identity and are not break-glass accounts, so ' +
                      'with passwords off they could not sign in until one ' +
                      'is linked.'}
            </p>
            <ul className="mt-2 space-y-1.5">
                {admins.map(a => (
                    <li
                        key={a.id}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-glass-border bg-canvas-elevated"
                    >
                        <span className="text-xs text-ink truncate flex-1 min-w-0">
                            {a.email}
                        </span>
                        {a.role && (
                            <span className="shrink-0 text-[10px] text-ink-muted">
                                {a.role === 'org_admin' ? 'Org admin' : 'Super Admin'}
                            </span>
                        )}
                        <button
                            type="button"
                            onClick={() => onMake(a)}
                            disabled={marking !== null}
                            aria-label={`Make ${a.email} a break-glass account`}
                            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-glass-border text-[11px] font-medium text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                        >
                            {marking === a.id && <Loader2 className="w-3 h-3 animate-spin" />}
                            Make break-glass
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    )
}

/** Why passwords cannot go off yet, and the two ways to fix it — calm,
 *  because nothing is broken: the server refused to leave nobody able to
 *  get in when the IdP is down. */
function NoBreakGlassGuidance() {
    return (
        <div className="mt-2 p-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.05]">
            <p className="text-xs text-ink leading-relaxed">
                Not yet — no break-glass account is ready, so an IdP outage
                would leave nobody able to get in. Mark an operational Super
                Admin who has a password as a system account under{' '}
                <a href="/admin/users" className="font-medium text-accent-lineage hover:underline">
                    Admin → Users
                </a>
                , then try again.
            </p>
            <p className="mt-1.5 text-[11px] text-ink-muted leading-relaxed">
                Or on the host:{' '}
                <code className="font-mono text-[10px] text-ink-secondary break-all">
                    python -m backend.scripts.reset_admin_password --email … --break-glass
                </code>
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
            onError(errText(
                err, 'Could not count the sessions still open through a connection.',
            ))
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
            onError(errText(
                err, 'Could not sign out the people signed in through a connection.',
            ))
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
            onError(errText(err, 'Could not count the open sessions.'))
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
            onError(errText(err, 'Could not sign everyone out.'))
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
