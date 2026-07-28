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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
    AlertTriangle, Check, ChevronDown, DoorOpen, Loader2, Mail,
    ShieldCheck, UserPlus,
} from 'lucide-react'

import {
    ssoAdminService,
    type AuthConfig,
    type IdpProvider,
} from '@/services/ssoAdminService'
import { cn } from '@/lib/utils'
import { ErrorBanner } from './ErrorBanner'
import { describePosture, riskChecks, type PostureTone } from './settings/posture'
import { SsoCard, SsoSectionLabel, type CardTone } from '../ui/SsoCard'

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
                    'and turning it back on restores every connection as it was.',
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
                    'lock out an active admin who has no SSO identity.',
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
    const [pending, setPending] = useState<keyof AuthConfig | null>(null)
    const [confirming, setConfirming] = useState<keyof AuthConfig | null>(null)

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

    async function apply(field: keyof AuthConfig, value: boolean) {
        if (!cfg) return
        setPending(field)
        try {
            setCfg(await ssoAdminService.updateAuthConfig({
                [field]: value, expectedVersion: cfg.version,
            } as never))
            setError(null)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setPending(null)
            setConfirming(null)
        }
    }

    if (cfg === null && error === null) {
        return (
            <div className="py-16 flex items-center justify-center gap-2 text-sm text-ink-muted">
                <Loader2 className="w-4 h-4 animate-spin" />
                Reading the current posture…
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
                                onRequest={next => {
                                    if (s.confirmOff && !next) setConfirming(s.field)
                                    else void apply(s.field, next)
                                }}
                                onConfirm={() => void apply(s.field, false)}
                                onCancel={() => setConfirming(null)}
                            />
                        ))}
                    </div>
                </motion.section>
            ))}

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
    def, value, risk, pending, disabled, confirming,
    onRequest, onConfirm, onCancel,
}: {
    def: SwitchDef
    value: boolean
    risk?: { tone: PostureTone; message: string }
    pending: boolean
    disabled: boolean
    confirming: boolean
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
