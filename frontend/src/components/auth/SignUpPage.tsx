import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Lock, User, AtSign, ChevronRight, AlertCircle, ShieldCheck, CheckCircle2, Sparkles } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { authService } from '@/services/authService'
import { cn } from '@/lib/utils'

// Lazy-load zxcvbn to keep the initial bundle small
let zxcvbnModule: typeof import('@zxcvbn-ts/core') | null = null
async function loadZxcvbn() {
    if (zxcvbnModule) return zxcvbnModule
    const [core, langCommon, langEn] = await Promise.all([
        import('@zxcvbn-ts/core'),
        import('@zxcvbn-ts/language-common'),
        import('@zxcvbn-ts/language-en'),
    ])
    core.zxcvbnOptions.setOptions({
        translations: langEn.translations,
        graphs: langCommon.adjacencyGraphs,
        dictionary: {
            ...langCommon.dictionary,
            ...langEn.dictionary,
        },
    })
    zxcvbnModule = core
    return core
}

const STRENGTH_COLORS = ['bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-yellow-400', 'bg-green-500']
const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong']

export function SignUpPage() {
    const [firstName, setFirstName] = useState('')
    const [lastName, setLastName] = useState('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [passwordScore, setPasswordScore] = useState(-1)
    const [passwordFeedback, setPasswordFeedback] = useState('')
    const [successMessage, setSuccessMessage] = useState('')

    // Invite token handling
    const [searchParams] = useSearchParams()
    const inviteToken = searchParams.get('invite')
    const [inviteRole, setInviteRole] = useState<string | null>(null)
    const [inviteValid, setInviteValid] = useState<boolean | null>(null)

    const navigate = useNavigate()
    const { signup, error, clearError, isLoading, isAuthenticated } = useAuthStore()

    // If already authenticated, redirect to homepage
    useEffect(() => {
        if (isAuthenticated) navigate('/', { replace: true })
    }, [isAuthenticated, navigate])

    useEffect(() => { clearError() }, [clearError])

    // Verify invite token on mount
    useEffect(() => {
        if (!inviteToken) return
        authService.verifyInvite(inviteToken).then((res) => {
            setInviteValid(res.valid)
            setInviteRole(res.role)
        }).catch(() => {
            setInviteValid(false)
        })
    }, [inviteToken])

    // Debounced password strength check
    useEffect(() => {
        if (!password) {
            setPasswordScore(-1)
            setPasswordFeedback('')
            return
        }
        const timer = setTimeout(async () => {
            const zxcvbn = await loadZxcvbn()
            const result = zxcvbn.zxcvbn(password)
            setPasswordScore(result.score)
            const fb = result.feedback
            const parts: string[] = []
            if (fb.warning) parts.push(fb.warning)
            if (fb.suggestions?.length) parts.push(...fb.suggestions)
            setPasswordFeedback(parts.join(' '))
        }, 300)
        return () => clearTimeout(timer)
    }, [password])

    const passwordsMatch = confirmPassword.length === 0 || password === confirmPassword
    const canSubmit = firstName && lastName && email && password && confirmPassword && passwordsMatch && passwordScore >= 3 && !isLoading

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!canSubmit) return
        const req: Parameters<typeof signup>[0] = { email, password, firstName, lastName }
        if (inviteToken && inviteValid) req.inviteToken = inviteToken
        const result = await signup(req)
        if (result.ok) {
            setSuccessMessage(result.message)
        }
    }

    return (
        <div className="relative min-h-screen w-full flex items-center justify-center overflow-hidden bg-canvas font-sans">
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
                    className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-accent-lineage/10 rounded-full blur-[120px]"
                />
                <motion.div
                    animate={{
                        scale: [1, 1.3, 1],
                        rotate: [0, -45, 0],
                        x: [0, -80, 0],
                        y: [0, 60, 0]
                    }}
                    transition={{ duration: 25, repeat: Infinity, ease: "linear" }}
                    className="absolute -bottom-[10%] -right-[10%] w-[50%] h-[50%] bg-accent-business/10 rounded-full blur-[140px]"
                />
                <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 brightness-100 contrast-150 mix-blend-overlay pointer-events-none" />
            </div>

            {/* Sign Up Card */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                className="relative z-10 w-full max-w-[420px] px-6"
            >
                <div className="glass-panel p-8 md:p-10 rounded-[2rem] border-white/20 dark:border-white/5 shadow-2xl overflow-hidden backdrop-blur-3xl">
                    {/* Logo / Header */}
                    <div className="flex flex-col items-center mb-8">
                        <motion.div
                            initial={{ scale: 0.8, rotate: -10 }}
                            animate={{ scale: 1, rotate: 0 }}
                            transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
                            className="w-16 h-16 mb-6 rounded-2xl bg-gradient-to-br from-accent-lineage to-accent-lineage/80 flex items-center justify-center shadow-lg shadow-accent-lineage/30"
                        >
                            <ShieldCheck className="w-8 h-8 text-white" />
                        </motion.div>
                        <h1 className="text-3xl font-bold tracking-tight text-ink mb-2">
                            Nexus<span className="gradient-text">Lineage</span>
                        </h1>
                        <p className="text-sm text-ink-secondary text-center">
                            {inviteToken && inviteValid
                                ? "You've been invited to join"
                                : 'Create your account'}
                        </p>
                    </div>

                    {/* Invite banner */}
                    {inviteToken && inviteValid && (
                        <div className="flex items-center gap-2.5 p-3 mb-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                            <Sparkles className="w-4 h-4 text-emerald-500 shrink-0" />
                            <p className="text-xs text-emerald-700 dark:text-emerald-300">
                                Your account will be activated immediately as <span className="font-semibold capitalize">{inviteRole}</span>.
                            </p>
                        </div>
                    )}
                    {inviteToken && inviteValid === false && (
                        <div className="flex items-center gap-2.5 p-3 mb-4 rounded-xl bg-red-500/10 border border-red-500/20">
                            <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                            <p className="text-xs text-red-600 dark:text-red-400">
                                This invite link is invalid or has expired. You can still sign up — your account will require admin approval.
                            </p>
                        </div>
                    )}

                    {/* Success State */}
                    <AnimatePresence mode="wait">
                        {successMessage ? (
                            <motion.div
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                className="text-center space-y-4"
                            >
                                <div className="w-16 h-16 mx-auto rounded-full bg-green-500/10 flex items-center justify-center">
                                    <CheckCircle2 className="w-8 h-8 text-green-500" />
                                </div>
                                <p className="text-sm text-ink-secondary" role="status">{successMessage}</p>
                                <Link
                                    to="/login"
                                    className="inline-block text-sm font-semibold text-accent-lineage hover:underline"
                                >
                                    Back to sign in
                                </Link>
                            </motion.div>
                        ) : (
                            <form onSubmit={handleSubmit} className="space-y-4">
                                {/* Name Row */}
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted ml-1" htmlFor="firstName">
                                            First Name
                                        </label>
                                        <div className="relative group">
                                            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors">
                                                <User className="w-4 h-4" />
                                            </div>
                                            <input
                                                id="firstName"
                                                type="text"
                                                placeholder="Jane"
                                                value={firstName}
                                                onChange={(e) => setFirstName(e.target.value)}
                                                className="input pl-10 h-11 bg-white/50 dark:bg-black/20 border-white/40 dark:border-white/10"
                                                required
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted ml-1" htmlFor="lastName">
                                            Last Name
                                        </label>
                                        <div className="relative group">
                                            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors">
                                                <User className="w-4 h-4" />
                                            </div>
                                            <input
                                                id="lastName"
                                                type="text"
                                                placeholder="Doe"
                                                value={lastName}
                                                onChange={(e) => setLastName(e.target.value)}
                                                className="input pl-10 h-11 bg-white/50 dark:bg-black/20 border-white/40 dark:border-white/10"
                                                required
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Email */}
                                <div className="space-y-1.5">
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
                                            placeholder="jane@company.com"
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            className="input pl-10 h-11 bg-white/50 dark:bg-black/20 border-white/40 dark:border-white/10"
                                            required
                                        />
                                    </div>
                                </div>

                                {/* Password */}
                                <div className="space-y-1.5">
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
                                            className="input pl-10 h-11 bg-white/50 dark:bg-black/20 border-white/40 dark:border-white/10"
                                            required
                                            minLength={8}
                                        />
                                    </div>
                                    {/* Strength Meter */}
                                    {password.length > 0 && passwordScore >= 0 && (
                                        <div className="space-y-1 pt-1">
                                            <div className="flex gap-1 h-1.5">
                                                {[0, 1, 2, 3, 4].map((i) => (
                                                    <div
                                                        key={i}
                                                        className={cn(
                                                            'flex-1 rounded-full transition-colors duration-300',
                                                            i <= passwordScore ? STRENGTH_COLORS[passwordScore] : 'bg-black/10 dark:bg-white/10'
                                                        )}
                                                    />
                                                ))}
                                            </div>
                                            <div className="flex justify-between items-center">
                                                <p className="text-[11px] text-ink-muted">{STRENGTH_LABELS[passwordScore]}</p>
                                                {passwordScore < 3 && passwordFeedback && (
                                                    <p className="text-[11px] text-ink-muted truncate ml-2">{passwordFeedback}</p>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Confirm Password */}
                                <div className="space-y-1.5">
                                    <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted ml-1" htmlFor="confirmPassword">
                                        Confirm Password
                                    </label>
                                    <div className="relative group">
                                        <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors">
                                            <Lock className="w-4 h-4" />
                                        </div>
                                        <input
                                            id="confirmPassword"
                                            type="password"
                                            placeholder="••••••••"
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            className={cn(
                                                "input pl-10 h-11 bg-white/50 dark:bg-black/20 border-white/40 dark:border-white/10",
                                                !passwordsMatch && "border-red-500/50 focus:ring-red-500/30"
                                            )}
                                            required
                                        />
                                    </div>
                                    {!passwordsMatch && (
                                        <p className="text-[11px] text-red-500 ml-1">Passwords do not match</p>
                                    )}
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
                                    disabled={!canSubmit}
                                    className={cn(
                                        "w-full h-12 rounded-xl bg-accent-lineage text-white font-semibold shadow-lg shadow-accent-lineage/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2",
                                        !canSubmit ? "opacity-70 cursor-not-allowed" : "hover:brightness-110"
                                    )}
                                >
                                    {isLoading ? (
                                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        <>
                                            Create Account
                                            <ChevronRight className="w-4 h-4" />
                                        </>
                                    )}
                                </button>

                                {/* Sign In Link */}
                                <div className="text-center pt-2 space-y-2">
                                    <p className="text-xs text-ink-muted">
                                        Already have an account?{' '}
                                        <Link to="/login" className="text-accent-lineage font-semibold hover:underline">
                                            Sign in
                                        </Link>
                                    </p>
                                    <p className="text-xs text-ink-muted">
                                        <a href="/docs" target="_blank" rel="noopener noreferrer" className="text-accent-lineage/70 hover:text-accent-lineage hover:underline transition-colors">
                                            Documentation
                                        </a>
                                    </p>
                                </div>
                            </form>
                        )}
                    </AnimatePresence>
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
                    <span>© 2026 Nexus Lineage</span>
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
