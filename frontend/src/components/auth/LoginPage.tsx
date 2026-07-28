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
function SsoButtons({
    providers,
    failed,
    onPortalError,
    showDivider = true,
}: {
    providers: SsoProviderSummary[] | null
    failed: boolean
    onPortalError: (message: string) => void
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
        if (ok) navigate('/', { replace: true })
    }

    const next = encodeURIComponent('/dashboard')
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
            <div className="mt-6 pt-6 border-t border-white/10 text-center">
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
            showDivider && "mt-6 pt-6 border-t border-white/10",
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
                            "flex items-center justify-center gap-2 w-full text-center py-2.5",
                            "rounded-xl border text-sm font-medium transition-colors",
                            "border-white/20 text-ink hover:bg-white/5",
                            busySlug === p.slug && "opacity-70 cursor-not-allowed",
                        )}
                    >
                        {p.buttonIcon && (
                            <img src={p.buttonIcon} alt="" aria-hidden
                                 className="w-4 h-4 shrink-0 object-contain" />
                        )}
                        {p.buttonLabel || p.displayName}
                        {busySlug === p.slug
                            ? <div className="w-3.5 h-3.5 border-2 border-ink-muted/30 border-t-ink rounded-full animate-spin" />
                            : <ChevronRight className="w-3.5 h-3.5 opacity-50" />}
                    </button>
                ) : (
                    <a
                        key={p.id}
                        href={`/api/v1/auth/${encodeURIComponent(p.slug)}/login?next=${next}`}
                        className={cn(
                            "flex items-center justify-center gap-2 w-full text-center py-2.5",
                            "rounded-xl border text-sm font-medium transition-colors",
                            p.kind === 'custom'
                                ? "border-yellow-500/40 text-yellow-300 hover:bg-yellow-500/5"
                                : "border-white/20 text-ink hover:bg-white/5",
                        )}
                    >
                        {p.buttonIcon && (
                            <img src={p.buttonIcon} alt="" aria-hidden
                                 className="w-4 h-4 shrink-0 object-contain" />
                        )}
                        {p.buttonLabel || p.displayName}
                        <ExternalLink className="w-3.5 h-3.5 opacity-50" />
                    </a>
                )
            ))}
            {/* Dev-login button is always offered when the env flag is
                set, even if no ``custom`` provider exists yet — clicking
                it lands on /dev-login which guides the operator. */}
            {customEnabled && !providers?.some((p) => p.kind === 'custom') && (
                <a
                    href={`/dev-login?next=${next}`}
                    className="block w-full text-center py-2.5 rounded-xl border border-yellow-500/40 text-sm font-medium text-yellow-300 hover:bg-yellow-500/5 transition-colors"
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

    const {
        login, error, clearError, isLoading, isAuthenticated, status,
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

        const candidates = providers.filter(needsBrowserPayload)
        if (candidates.length !== 1) return
        const payload = readBrowserProfile(candidates[0])
        if (!payload) return

        autoAttempted.current = true
        markAutoPortalTried()
        void loginWithBrowserProfile(candidates[0].slug, payload).then((ok) => {
            if (ok) navigate('/', { replace: true })
        })
    }, [providers, isAuthenticated, loginWithBrowserProfile, navigate])

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

    // If already authenticated, redirect to dashboard
    useEffect(() => {
        if (isAuthenticated) navigate('/', { replace: true })
    }, [isAuthenticated, navigate])

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
        if (ok) navigate('/', { replace: true })
    }

    // Avoid flashing the form to a user who's about to be redirected to
    // the dashboard because their cookie is still valid.
    if (status === 'idle' || status === 'loading') {
        return (
            <div className="min-h-screen w-full flex items-center justify-center bg-canvas">
                <div className="w-8 h-8 border-2 border-ink-muted/30 border-t-accent-lineage rounded-full animate-spin" />
            </div>
        )
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
                            className="mt-4 flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-accent-lineage text-white text-sm font-semibold hover:brightness-110 transition-all"
                        >
                            Continue with {routed.buttonLabel || routed.displayName}
                            <ChevronRight className="w-4 h-4" />
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
