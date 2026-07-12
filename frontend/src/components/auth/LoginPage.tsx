import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Lock, AtSign, ChevronRight, AlertCircle, ShieldCheck, ExternalLink } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { authService, type SsoProviderSummary } from '@/services/authService'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { useBrand } from '@/store/branding'
import { useDocumentTitle } from '@/lib/useDocumentTitle'


// SSO is initiated by a top-level GET so the IdP redirect flow works
// (a fetch would lose the cookie + redirect chain). The catalog comes
// from /api/v1/auth/providers — only enabled providers are returned,
// no client-side fan-out.
function SsoButtons() {
    const [providers, setProviders] = useState<SsoProviderSummary[] | null>(null)
    const [failed, setFailed] = useState(false)

    useEffect(() => {
        let cancelled = false
        authService.listProviders()
            .then((rows) => {
                if (!cancelled) setProviders(rows)
            })
            .catch(() => {
                if (!cancelled) setFailed(true)
            })
        return () => {
            cancelled = true
        }
    }, [])

    const next = encodeURIComponent('/dashboard')
    const customEnabled =
        (import.meta.env.VITE_AUTH_CUSTOM_PROVIDER_ENABLED ?? '')
            .toString()
            .toLowerCase() === 'true'

    if (providers === null && !failed) {
        // While the catalog is loading, render nothing — the password
        // form is the dependable fallback.
        return null
    }

    const hasProviders = providers !== null && providers.length > 0
    if (!hasProviders && !customEnabled) {
        return null
    }

    return (
        <div className="mt-6 pt-6 border-t border-white/10 space-y-3">
            <p className="text-[11px] text-center uppercase tracking-widest text-ink-muted">
                Or sign in with
            </p>
            {(providers ?? []).map((p) => (
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
                    {p.buttonLabel || p.displayName}
                    <ExternalLink className="w-3.5 h-3.5 opacity-50" />
                </a>
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
                            password below, then go to <span className="font-mono">Account → Identities</span>
                            {' '}to link your SSO provider securely.
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

export function LoginPage() {
    const brand = useBrand()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const navigate = useNavigate()
    const [params] = useSearchParams()

    const { login, error, clearError, isLoading, isAuthenticated, status } = useAuthStore()

    // Read ``?error_code=...&email=...`` from the SSO failure redirect
    // path. The collision modal is the most user-actionable case; other
    // codes fall through to a generic inline error.
    const errorCode = params.get('error_code')
    const collisionEmail = params.get('email')
    const [showCollision, setShowCollision] = useState(
        errorCode === 'unsafe_auto_link' && Boolean(collisionEmail),
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

    useDocumentTitle('Sign in')

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

                    {/* Form */}
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
                    </form>

                    {/* ── SSO ──────────────────────────────────────────── */}
                    {/* Each link is a top-level GET so the IdP redirect
                        flow works. The backend returns 404 for any
                        provider that isn't configured, and we render
                        the buttons unconditionally because the user has
                        the most context about which their org uses. */}
                    <SsoButtons />

                    {/* Footer Info */}
                    <div className="mt-8 text-center space-y-3">
                        <p className="text-xs text-ink-muted">
                            <Link to="/forgot-password" className="text-accent-lineage font-semibold hover:underline">
                                Forgot your password?
                            </Link>
                        </p>
                        <p className="text-xs text-ink-muted">
                            Don't have an account?{' '}
                            <Link to="/signup" className="text-accent-lineage font-semibold hover:underline">
                                Sign up
                            </Link>
                        </p>
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
