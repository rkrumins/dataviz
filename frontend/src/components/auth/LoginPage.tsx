import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Lock, AtSign, ChevronRight, AlertCircle, ShieldCheck, ExternalLink, X } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import {
    authService,
    needsBrowserPayload,
    readBrowserProfile,
    type LoginContext,
    type SsoProviderSummary,
} from '@/services/authService'
import { cn } from '@/lib/utils'
import { safeNext } from '@/lib/safeNext'
import { isSignedOut } from '@/store/signedOut'
import { Backdrop } from '@/components/ui/Backdrop'
import { useBrand } from '@/store/branding'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useFeature } from '@/store/features'


// Redirect-based SSO (oidc / saml2 / custom, and custom_profile rows
// sourced from a cookie or header) is initiated by a top-level GET so
// the IdP redirect flow works — a fetch would lose the cookie + redirect
// chain. custom_profile rows sourced from browser storage are the
// exception: only JS can read the key, so those POST it instead.
// The catalog comes from /api/v1/auth/providers — only enabled
// providers are returned, no client-side fan-out.
/**
 * One SSO button, visible on both themes.
 *
 * These carried `border-white/20 … hover:bg-white/5`, which is a border
 * on a light card that is the same colour as the card. On the light
 * theme the control was not faint — it was gone, and the only evidence
 * an SSO option existed at all was a lone icon floating under "Or sign
 * in with".
 *
 * The page states both themes explicitly rather than leaning on a
 * semantic token (see the inputs above: `bg-white/50 dark:bg-black/20`),
 * so these match that. A fill as well as a border, because this sits
 * directly under the password field and reads as a peer control.
 */
const SSO_BUTTON = [
    'group relative flex items-center justify-center w-full h-12',
    'rounded-xl border text-sm font-semibold transition-all duration-200',
    'text-ink bg-white/60 dark:bg-white/[0.04]',
    'border-black/10 dark:border-white/15',
    'hover:bg-white dark:hover:bg-white/[0.09]',
    'hover:border-accent-lineage/40 hover:shadow-md hover:shadow-accent-lineage/5',
    'hover:-translate-y-px active:translate-y-0',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50',
].join(' ')

/** The dev-login and `custom`-kind buttons, which say "not production"
 *  in amber. `text-yellow-300` on a white card is unreadable. */
const SSO_BUTTON_DEV = [
    'group relative flex items-center justify-center w-full h-12',
    'rounded-xl border text-sm font-semibold transition-all duration-200',
    'border-yellow-500/40 text-yellow-700 dark:text-yellow-300',
    'bg-yellow-500/[0.06] hover:bg-yellow-500/10',
    'hover:-translate-y-px active:translate-y-0',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500/50',
].join(' ')

/**
 * What to call the connection.
 *
 * The operator's own ``buttonLabel`` wins outright — they wrote it to be
 * read. Otherwise the display name, which is what Admin → SSO asks for
 * and is required to be non-blank at both create and update.
 *
 * The slug is the floor and should never be reached. It exists because a
 * control with no accessible name is unusable, and for a while every
 * button had one: the API served the catalog snake_case while this file
 * read camelCase, so ``displayName`` arrived undefined. Presented rather
 * than raw — ``corporate-portal`` is an identifier, "Corporate Portal"
 * is a name, and if we are down to the last resort it should still look
 * like something a person chose.
 */
function ssoName(p: SsoProviderSummary): string {
    const chosen = p.displayName?.trim()
    if (chosen) return chosen
    return p.slug
        .split(/[-_.]+/)
        .filter(Boolean)
        .map(w => w[0].toUpperCase() + w.slice(1))
        .join(' ')
}

/** The full string on the button. "Continue with X" is the phrasing every
 *  SSO button on the web uses, and it reads as an invitation rather than
 *  as a bare noun sitting in a box. An operator-set label is used
 *  verbatim — they may well have written "Continue with" themselves. */
function ssoLabel(p: SsoProviderSummary): string {
    return p.buttonLabel?.trim() || `Continue with ${ssoName(p)}`
}

/**
 * The provider's mark, or a stand-in for it.
 *
 * A leading mark is what makes this read as a real sign-in option rather
 * than a secondary link — it is the shape people recognise from every
 * other "Continue with" button. Most connections have no uploaded icon,
 * so the initial in a tinted tile stands in: still an anchor for the eye,
 * still identifiable at a glance when two connections are listed.
 */
function SsoMark({ p }: { p: SsoProviderSummary }) {
    if (p.buttonIcon) {
        return (
            <img src={p.buttonIcon} alt="" aria-hidden
                 className="w-5 h-5 shrink-0 object-contain" />
        )
    }
    return (
        <span
            aria-hidden="true"
            className="flex items-center justify-center w-7 h-7 shrink-0 rounded-lg bg-gradient-to-br from-violet-500/20 to-indigo-500/10 text-[11px] font-bold text-accent-lineage"
        >
            {ssoName(p).charAt(0).toUpperCase()}
        </span>
    )
}

function SsoButtons({
    providers,
    failed,
    onPortalError,
    nextPath,
    showDivider = true,
}: {
    providers: SsoProviderSummary[] | null
    failed: boolean
    onPortalError: (message: string) => void
    /** Where to land after a portal sign-in — the page an expiry
     *  interrupted, not always the dashboard. */
    nextPath: string
    /** "Or sign in with" only makes sense when there is something above
     *  to be an alternative *to*. On an SSO-only deployment with a single
     *  provider these buttons are the whole page. */
    showDivider?: boolean
}) {
    const navigate = useNavigate()
    const loginWithBrowserProfile = useAuthStore((s) => s.loginWithBrowserProfile)
    const [busySlug, setBusySlug] = useState<string | null>(null)

    // ``custom_profile`` providers backed by browser storage can't use a
    // top-level GET — only JS can read the key. Read it, post it, then
    // navigate ourselves once the session cookies are set.
    async function signInWithPortal(p: SsoProviderSummary) {
        const payload = readBrowserProfile(p)
        if (!payload) {
            onPortalError(
                `No ${p.displayName} session found in this browser. ` +
                'Sign in to the portal first, then try again.',
            )
            return
        }
        onPortalError('')
        setBusySlug(p.slug)
        const ok = await loginWithBrowserProfile(p.slug, payload)
        setBusySlug(null)
        if (ok) navigate(nextPath, { replace: true })
    }

    const next = encodeURIComponent(nextPath === '/' ? '/dashboard' : nextPath)
    const customEnabled =
        (import.meta.env.VITE_AUTH_CUSTOM_PROVIDER_ENABLED ?? '')
            .toString()
            .toLowerCase() === 'true'

    if (failed) {
        // Not silence: on an SSO-only deployment the buttons are the only
        // way in, so "nothing rendered" is an unrecoverable dead end with
        // no explanation. Muted rather than alarming — it isn't the user's
        // fault, and the password form may still work.
        return (
            <div className="mt-6 pt-6 border-t border-black/10 dark:border-white/10 text-center">
                <p className="text-xs text-ink-muted">
                    Couldn't load single sign-on options.{' '}
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="text-accent-lineage hover:underline"
                    >
                        Retry
                    </button>
                    {' '}or sign in with your password.
                </p>
            </div>
        )
    }

    if (providers === null) {
        // While the catalog is loading, render nothing — the password
        // form is the dependable fallback.
        return null
    }

    const hasProviders = providers.length > 0
    if (!hasProviders && !customEnabled) {
        return null
    }

    return (
        <div className={cn(
            "space-y-3",
            showDivider && "mt-6 pt-6 border-t border-black/10 dark:border-white/10",
        )}>
            {showDivider && (
                <p className="text-[11px] text-center uppercase tracking-widest text-ink-muted">
                    Or sign in with
                </p>
            )}
            {(providers ?? []).map((p) => (
                needsBrowserPayload(p) ? (
                    <button
                        key={p.id}
                        type="button"
                        disabled={busySlug === p.slug}
                        onClick={() => { void signInWithPortal(p) }}
                        className={cn(
                            SSO_BUTTON,
                            busySlug === p.slug && "opacity-70 cursor-not-allowed",
                        )}
                    >
                        {/* Mark and affordance are pinned to the edges so
                            the label stays optically centred however long
                            the provider's name is. */}
                        <span className="absolute left-3 flex items-center">
                            <SsoMark p={p} />
                        </span>
                        <span className="px-12 truncate">{ssoLabel(p)}</span>
                        <span className="absolute right-3.5 flex items-center">
                            {busySlug === p.slug
                                ? <div className="w-3.5 h-3.5 border-2 border-ink-muted/30 border-t-ink rounded-full animate-spin" />
                                : <ChevronRight className="w-4 h-4 text-ink-muted transition-transform duration-200 group-hover:translate-x-0.5" />}
                        </span>
                    </button>
                ) : (
                    <a
                        key={p.id}
                        href={`/api/v1/auth/${encodeURIComponent(p.slug)}/login?next=${next}`}
                        className={p.kind === 'custom' ? SSO_BUTTON_DEV : SSO_BUTTON}
                    >
                        <span className="absolute left-3 flex items-center">
                            <SsoMark p={p} />
                        </span>
                        <span className="px-12 truncate">{ssoLabel(p)}</span>
                        {/* ExternalLink rather than a chevron: this one
                            leaves the page for the IdP, and saying so is
                            worth more than a consistent glyph. */}
                        <span className="absolute right-3.5 flex items-center">
                            <ExternalLink className="w-4 h-4 text-ink-muted transition-transform duration-200 group-hover:-translate-y-px group-hover:translate-x-0.5" />
                        </span>
                    </a>
                )
            ))}
            {/* Dev-login button is always offered when the env flag is
                set, even if no ``custom`` provider exists yet — clicking
                it lands on /dev-login which guides the operator. */}
            {customEnabled && !providers?.some((p) => p.kind === 'custom') && (
                <a
                    href={`/dev-login?next=${next}`}
                    className={SSO_BUTTON_DEV}
                >
                    Dev Login (mock IdP) — non-production
                </a>
            )}
        </div>
    )
}


/** Collision modal — rendered when the SSO callback redirects with
 *  ``?error_code=unsafe_auto_link&email=...``. Guides the user through
 *  the link-by-password recovery path instead of the cryptic
 *  ``sso_error=1`` page. */
function CollisionModal({ email, onClose }: { email: string; onClose: () => void }) {
    return (
        <>
        <Backdrop open={true} onClick={onClose} zClassName="z-50" className="bg-black/60" />
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                onClick={(e) => e.stopPropagation()}
                className="pointer-events-auto max-w-md w-full p-6 rounded-2xl bg-canvas border border-white/15 shadow-xl"
            >
                <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 mt-0.5 text-yellow-400 shrink-0" />
                    <div>
                        <h2 className="text-base font-semibold text-ink">
                            An account for <span className="font-mono">{email}</span> already exists
                        </h2>
                        <p className="mt-2 text-sm text-ink-secondary">
                            We won't auto-link your SSO identity to it because your
                            IdP hasn't verified the email address. Sign in with your
                            password below, then open{' '}
                            <Link
                                to="/me/identities"
                                className="text-accent-lineage font-semibold hover:underline"
                            >
                                Identities
                            </Link>
                            {' '}from the user menu to link your SSO provider securely.
                        </p>
                        <button
                            onClick={onClose}
                            className="mt-4 px-4 py-2 rounded-lg bg-accent-lineage text-white text-sm font-medium hover:brightness-110"
                        >
                            Sign in with password
                        </button>
                    </div>
                </div>
            </motion.div>
        </div>
        </>
    )
}

/** Shown when the SSO callback bounced back with ``?sso_error=1``.
 *
 *  The precise reason is deliberately withheld here — it is admin-only by
 *  construction and lives in the audit log. What the user gets instead is
 *  the reference, which is the only thing that lets an admin find the
 *  reason. Without this the whole correlation chain dead-ends: the ref was
 *  minted, audited and put in the URL, and then shown to nobody. */
function SsoFailureBanner({ reference, onDismiss }: {
    reference: string | null
    onDismiss: () => void
}) {
    const [copied, setCopied] = useState(false)

    async function copy() {
        if (!reference) return
        try {
            await navigator.clipboard.writeText(reference)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            // Clipboard unavailable (insecure context / denied). The ref is
            // selectable text either way, so this is cosmetic.
        }
    }

    return (
        <div
            role="alert"
            className="mb-5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm"
        >
            <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
                <div className="flex-1 min-w-0">
                    <p className="text-red-300">
                        Sign-in through your identity provider didn't complete.
                    </p>
                    {reference && (
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-ink-muted">
                                Quote this reference to your administrator:
                            </span>
                            <button
                                type="button"
                                onClick={() => { void copy() }}
                                title="Copy reference"
                                className="px-2 py-0.5 rounded font-mono text-xs bg-black/20 border border-white/10 hover:bg-black/30 transition-colors"
                            >
                                {copied ? 'copied' : reference}
                            </button>
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label="Dismiss"
                    className="text-ink-muted hover:text-ink shrink-0"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
    )
}

/**
 * Shown when someone lands on /login and the session turns out to still
 * be valid.
 *
 * That case used to resolve itself silently — a straight bounce into the
 * app. Combined with the silent refresh-on-401 (now exempt on this
 * route), even an EXPIRED access cookie signed people back in without a
 * keystroke. Either way there was no way to sign in as somebody else,
 * which is a thing people genuinely need: a shared machine, a second
 * tenant, an admin account alongside a normal one.
 */
function AlreadySignedIn({ email, nextPath }: { email: string; nextPath: string }) {
    const navigate = useNavigate()
    const logout = useAuthStore((s) => s.logout)
    const [switching, setSwitching] = useState(false)

    async function switchAccount() {
        setSwitching(true)
        // Drop the server session FIRST. Without this, "someone else"
        // would be typing their password on a page still holding the
        // previous user's cookies. ``logout`` swallows its own errors
        // and clears local state either way, so this component always
        // unmounts — no need to unwind ``switching``.
        await logout()
    }

    return (
        <div className="min-h-screen w-full flex items-center justify-center bg-canvas font-sans p-6">
            <div className="glass-panel w-full max-w-[420px] p-8 rounded-[2rem] border-white/20 dark:border-white/5 shadow-2xl text-center">
                <div className="w-14 h-14 mb-5 mx-auto rounded-2xl bg-gradient-to-br from-accent-lineage to-accent-lineage/80 flex items-center justify-center shadow-lg shadow-accent-lineage/30">
                    <ShieldCheck className="w-7 h-7 text-white" />
                </div>
                <h1 className="text-lg font-bold text-ink">
                    You're already signed in as {email}
                </h1>
                <div className="mt-6 space-y-3">
                    <button
                        type="button"
                        onClick={() => navigate(nextPath, { replace: true })}
                        className="w-full h-12 rounded-xl bg-accent-lineage text-white font-semibold shadow-lg shadow-accent-lineage/20 transition-all active:scale-[0.98] hover:brightness-110 flex items-center justify-center gap-2"
                    >
                        Continue
                        <ChevronRight className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => { void switchAccount() }}
                        disabled={switching}
                        className={cn(
                            "w-full h-12 rounded-xl border border-white/20 text-sm font-medium text-ink transition-colors",
                            switching ? "opacity-70 cursor-not-allowed" : "hover:bg-white/5",
                        )}
                    >
                        {switching ? 'Signing out…' : 'Sign in as someone else'}
                    </button>
                </div>
            </div>
        </div>
    )
}

/** Session-scoped guard so a rejected auto-attempt can't relaunch on
 *  every render or on a bounce back to /login. A fresh tab retries. */
const AUTO_PORTAL_SENTINEL = 'nx_portal_autologin_tried'

function autoPortalAlreadyTried(): boolean {
    try {
        return window.sessionStorage.getItem(AUTO_PORTAL_SENTINEL) === '1'
    } catch {
        return false
    }
}

function markAutoPortalTried() {
    try {
        window.sessionStorage.setItem(AUTO_PORTAL_SENTINEL, '1')
    } catch {
        // Storage unavailable — the worst case is one retry per render
        // cycle guarded by the in-flight ref below.
    }
}

export function LoginPage() {
    const signupEnabled = useFeature('signupEnabled')
    const brand = useBrand()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const navigate = useNavigate()
    const [params] = useSearchParams()

    // Where an expiry interrupted them. AppLayout puts the path it was
    // bouncing on into ``?next=``, so signing back in returns you to the
    // page you were reading rather than to the dashboard — losing your
    // place was itself one of the "odd things that happen when the token
    // expires". Sanitised: this value comes from the URL, so an attacker
    // gets to choose it.
    const nextPath = safeNext(params.get('next'), '/')

    const {
        login, error, clearError, isLoading, isAuthenticated, status, user,
        loginWithBrowserProfile,
    } = useAuthStore()

    // The page's shape is a function of the platform posture, not a fixed
    // layout. See ``pageShape`` below.
    const [context, setContext] = useState<LoginContext | null>(null)
    const [contextFailed, setContextFailed] = useState(false)
    const [routed, setRouted] = useState<SsoProviderSummary | null>(null)
    const [portalError, setPortalError] = useState<string | null>(null)
    // Escape hatch out of the email-first flow. Never shown when local
    // login is off — there would be nothing to escape to.
    const [forcePassword, setForcePassword] = useState(false)
    // "Other ways to sign in" disclosure, for the postures that tuck the
    // full button row away.
    const [showAllProviders, setShowAllProviders] = useState(false)

    useEffect(() => {
        let cancelled = false
        authService.loginContext()
            .then((ctx) => { if (!cancelled) setContext(ctx) })
            .catch(() => { if (!cancelled) setContextFailed(true) })
        return () => { cancelled = true }
    }, [])

    const providers = context?.providers ?? null

    // Silent portal sign-in: on an internal deployment the corporate
    // portal has already written the profile, so the login form is a
    // speed bump. Attempt it once per tab when exactly one storage-
    // backed provider is configured and its key is present. A rejection
    // falls through to the normal form rather than looping.
    const autoAttempted = useRef(false)
    useEffect(() => {
        if (providers === null || autoAttempted.current) return
        if (isAuthenticated || autoPortalAlreadyTried()) return
        // Someone who signed out must not be signed straight back in by a
        // payload still sitting in browser storage. Server-side revocation
        // cannot stop this one: it isn't presenting a condemned
        // credential, it is asking for a brand-new session. The per-tab
        // sentinel above doesn't cover it either — open a new tab and it
        // is clear. This is the check that makes "sign out" stick.
        if (isSignedOut()) return

        const candidates = providers.filter(needsBrowserPayload)
        if (candidates.length !== 1) return
        const payload = readBrowserProfile(candidates[0])
        if (!payload) return

        autoAttempted.current = true
        markAutoPortalTried()
        void loginWithBrowserProfile(candidates[0].slug, payload).then((ok) => {
            if (ok) navigate(nextPath, { replace: true })
        })
    }, [providers, isAuthenticated, loginWithBrowserProfile, navigate, nextPath])

    // Read ``?error_code=...&email=...`` from the SSO failure redirect
    // path. The collision modal is the most user-actionable case; other
    // codes fall through to a generic inline error.
    const errorCode = params.get('error_code')
    const collisionEmail = params.get('email')
    const [showCollision, setShowCollision] = useState(
        errorCode === 'unsafe_auto_link' && Boolean(collisionEmail),
    )
    // ``sso_error=1`` is set on every SSO failure; ``ref`` correlates it to
    // the audit event. The collision case has its own modal, so this banner
    // covers everything else — which is the majority.
    const [showSsoFailure, setShowSsoFailure] = useState(
        params.get('sso_error') === '1' && errorCode !== 'unsafe_auto_link',
    )
    useEffect(() => {
        if (errorCode === 'unsafe_auto_link' && collisionEmail) {
            setEmail(collisionEmail)
        }
    }, [errorCode, collisionEmail])

    useEffect(() => {
        clearError()
    }, [clearError])

    // Debounced so it fires once the address looks finished, not on every
    // keystroke. A miss is silent by design — see /auth/resolve.
    //
    // Gated on the posture: without this it fired on every deployment,
    // including the ~99% with email-first off, where the endpoint can only
    // ever answer null.
    const emailFirst = context?.emailFirstLogin ?? false
    useEffect(() => {
        if (!emailFirst || !email.includes('@')) { setRouted(null); return }
        let cancelled = false
        const timer = setTimeout(() => {
            authService.resolveEmailDomain(email)
                .then((r) => { if (!cancelled) setRouted(r.provider) })
                .catch(() => { if (!cancelled) setRouted(null) })
        }, 400)
        return () => { cancelled = true; clearTimeout(timer) }
    }, [email, emailFirst])

    useDocumentTitle('Sign in')

    // ── What shape is this page? ─────────────────────────────────────
    //
    // Previously fixed: password form, divider, every provider as a
    // button — regardless of configuration. That meant an SSO-only
    // deployment led with a control the server always refuses, and
    // email-first routing appeared *below* the password form it was meant
    // to replace, so it removed neither the button row nor the topology
    // disclosure it existed to remove.
    //
    // Fails open on a context read that never arrived: local login on,
    // email-first off. A page with a form the server might refuse still
    // beats a page with nothing on it.
    const allowLocal = context?.allowLocalLogin ?? true
    const showPasswordForm = allowLocal && (!emailFirst || forcePassword)
    // Email-first leads with the routed provider and tucks the button row
    // behind a disclosure — otherwise it removes neither the coin flip nor
    // the topology disclosure it exists to remove.
    const leadWithEmail = emailFirst
    const showEmailField = showPasswordForm || leadWithEmail
    const showProviderRow = !leadWithEmail || showAllProviders

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!email || !password || isLoading) return
        const ok = await login(email, password)
        if (ok) navigate(nextPath, { replace: true })
    }

    // Avoid flashing the form to a user whose cookie is still being
    // checked.
    if (status === 'idle' || status === 'loading') {
        return (
            <div className="min-h-screen w-full flex items-center justify-center bg-canvas">
                <div className="w-8 h-8 border-2 border-ink-muted/30 border-t-accent-lineage rounded-full animate-spin" />
            </div>
        )
    }

    // A live session, on the one page whose job is to ask who you are.
    // Say so and let them choose — do not decide for them.
    if (isAuthenticated && user) {
        return <AlreadySignedIn email={user.email} nextPath={nextPath} />
    }

    return (
        <div className="relative min-h-screen w-full flex items-center justify-center overflow-hidden bg-canvas font-sans">
            {showCollision && collisionEmail && (
                <CollisionModal
                    email={collisionEmail}
                    onClose={() => setShowCollision(false)}
                />
            )}
            {/* Animated Background Elements */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <motion.div
                    animate={{
                        scale: [1, 1.2, 1],
                        rotate: [0, 90, 0],
                        x: [0, 100, 0],
                        y: [0, -50, 0]
                    }}
                    transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                    className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-accent-lineage/10 rounded-full blur-[120px] will-change-transform"
                />
                <motion.div
                    animate={{
                        scale: [1, 1.3, 1],
                        rotate: [0, -45, 0],
                        x: [0, -80, 0],
                        y: [0, 60, 0]
                    }}
                    transition={{ duration: 25, repeat: Infinity, ease: "linear" }}
                    className="absolute -bottom-[10%] -right-[10%] w-[50%] h-[50%] bg-accent-business/10 rounded-full blur-[140px] will-change-transform"
                />
                <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 brightness-100 contrast-150 mix-blend-overlay pointer-events-none" />
            </div>

            {/* Login Card */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                className="relative z-10 w-full max-w-[420px] px-6"
            >
                <div className="glass-panel p-8 md:p-10 rounded-[2rem] border-white/20 dark:border-white/5 shadow-2xl overflow-hidden backdrop-blur-3xl">
                    {/* Logo / Header */}
                    <div className="flex flex-col items-center mb-10">
                        <motion.div
                            initial={{ scale: 0.8, rotate: -10 }}
                            animate={{ scale: 1, rotate: 0 }}
                            transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
                            className="w-16 h-16 mb-6 rounded-2xl bg-gradient-to-br from-accent-lineage to-accent-lineage/80 flex items-center justify-center shadow-lg shadow-accent-lineage/30"
                        >
                            <ShieldCheck className="w-8 h-8 text-white" />
                        </motion.div>
                        <h1 className="text-3xl font-bold tracking-tight text-ink mb-2">
                            <span className="gradient-text">{brand.appName}</span>
                        </h1>
                        <p className="text-sm text-ink-secondary text-center">
                            {brand.loginTagline}
                        </p>
                    </div>

                    {showSsoFailure && (
                        <SsoFailureBanner
                            reference={params.get('ref')}
                            onDismiss={() => setShowSsoFailure(false)}
                        />
                    )}

                    {/* Form */}
                    {showEmailField && (
                    <form onSubmit={handleSubmit} className="space-y-5">
                        <div className="space-y-2">
                            <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted ml-1" htmlFor="email">
                                Email
                            </label>
                            <div className="relative group">
                                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors">
                                    <AtSign className="w-4 h-4" />
                                </div>
                                <input
                                    id="email"
                                    type="email"
                                    placeholder="admin@company.com"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="input pl-10 h-12 bg-white/50 dark:bg-black/20 border-white/40 dark:border-white/10"
                                    required
                                />
                            </div>
                        </div>

                        {showPasswordForm && (
                        <div className="space-y-2">
                            <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted ml-1" htmlFor="password">
                                Password
                            </label>
                            <div className="relative group">
                                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors">
                                    <Lock className="w-4 h-4" />
                                </div>
                                <input
                                    id="password"
                                    type="password"
                                    placeholder="••••••••"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="input pl-10 h-12 bg-white/50 dark:bg-black/20 border-white/40 dark:border-white/10"
                                    required
                                />
                            </div>
                        </div>
                        )}

                        {/* Error Message */}
                        <AnimatePresence mode="wait">
                            {error && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 text-sm"
                                >
                                    <AlertCircle className="w-4 h-4 shrink-0" />
                                    <p>{error}</p>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* Submit Button */}
                        {showPasswordForm && (
                        <button
                            type="submit"
                            disabled={isLoading}
                            className={cn(
                                "w-full h-12 rounded-xl bg-accent-lineage text-white font-semibold shadow-lg shadow-accent-lineage/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2",
                                isLoading ? "opacity-70 cursor-not-allowed" : "hover:brightness-110"
                            )}
                        >
                            {isLoading ? (
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            ) : (
                                <>
                                    Enter Workspace
                                    <ChevronRight className="w-4 h-4" />
                                </>
                            )}
                        </button>
                        )}

                        {/* Email-first, waiting on an address that routes
                            somewhere. Says so rather than leaving a lone
                            field with no visible next step. */}
                        {leadWithEmail && !routed && !showPasswordForm && (
                            <p className="text-xs text-center text-ink-muted">
                                Enter your work email to continue.
                            </p>
                        )}
                    </form>
                    )}

                    {/* ── SSO ──────────────────────────────────────────── */}
                    {/* Each link is a top-level GET so the IdP redirect
                        flow works. The backend returns 404 for any
                        provider that isn't configured. */}
                    {routed && (
                        <a
                            href={`/api/v1/auth/${encodeURIComponent(routed.slug)}/login?next=${encodeURIComponent('/dashboard')}`}
                            className="group mt-4 flex items-center justify-center gap-2 w-full h-12 rounded-xl bg-accent-lineage text-white text-sm font-semibold shadow-sm shadow-accent-lineage/25 hover:brightness-110 hover:shadow-md hover:shadow-accent-lineage/30 hover:-translate-y-px active:translate-y-0 transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50"
                        >
                            {/* Through ssoLabel, so a connection with no
                                display name cannot render "Continue with
                                undefined" here either. */}
                            {ssoLabel(routed)}
                            <ChevronRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                        </a>
                    )}

                    {/* Escape hatches out of the email-first flow. Offered
                        only when there is something to escape to: no
                        password link when local login is off, because the
                        server would refuse it. */}
                    {leadWithEmail && (
                        <div className="mt-4 flex flex-col items-center gap-2">
                            {allowLocal && !forcePassword && (
                                <button
                                    type="button"
                                    onClick={() => setForcePassword(true)}
                                    className="text-xs text-accent-lineage hover:underline"
                                >
                                    Use a password instead
                                </button>
                            )}
                            {!showAllProviders && (providers?.length ?? 0) > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setShowAllProviders(true)}
                                    className="text-xs text-ink-muted hover:text-ink"
                                >
                                    Other ways to sign in
                                </button>
                            )}
                        </div>
                    )}

                    {showProviderRow && (
                        <SsoButtons
                            providers={providers}
                            failed={contextFailed}
                            onPortalError={setPortalError}
                            nextPath={nextPath}
                            showDivider={showEmailField}
                        />
                    )}

                    {portalError && (
                        <div className="mt-4 flex items-start gap-2 p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20 text-yellow-300 text-sm">
                            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                            <p>{portalError}</p>
                        </div>
                    )}

                    {/* Footer Info */}
                    <div className="mt-8 text-center space-y-3">
                        {/* No password to forget when local login is off. */}
                        {allowLocal && (
                            <p className="text-xs text-ink-muted">
                                <Link to="/forgot-password" className="text-accent-lineage font-semibold hover:underline">
                                    Forgot your password?
                                </Link>
                            </p>
                        )}
                        {/* The server now REFUSES this signup (auth.py), so offering it would
                            hand someone a form that cannot submit. When self-registration is
                            off, an invite link is the only way in — and that still works. */}
                        {signupEnabled && (
                            <p className="text-xs text-ink-muted">
                                Don't have an account?{' '}
                                <Link to="/signup" className="text-accent-lineage font-semibold hover:underline">
                                    Sign up
                                </Link>
                            </p>
                        )}
                        <p className="text-xs text-ink-muted">
                            <a href="/docs" target="_blank" rel="noopener noreferrer" className="text-accent-lineage/70 hover:text-accent-lineage hover:underline transition-colors">
                                Documentation
                            </a>
                        </p>
                    </div>
                </div>

                {/* Subtle Decorative Bottom Info */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 1 }}
                    className="mt-6 flex justify-center gap-4 text-[10px] text-ink-muted/60 font-medium uppercase tracking-widest"
                >
                    <span>v0.1.0</span>
                    <span>•</span>
                    <span>{brand.copyrightText}</span>
                </motion.div>
            </motion.div>

            {/* Corner Accents */}
            <div className="absolute top-0 right-0 p-8 opacity-20">
                <div className="text-right">
                    <AtSign className="w-12 h-12 text-accent-lineage mb-2 opacity-10" />
                </div>
            </div>
        </div>
    )
}
