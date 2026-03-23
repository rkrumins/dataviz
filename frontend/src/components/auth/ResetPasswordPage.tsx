/**
 * ResetPasswordPage — user enters their reset token + new password.
 *
 * Accessible at /reset-password or /reset-password?token=xxx
 * The token can be pre-filled from the URL query param.
 */
import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Key, Lock, ChevronRight, AlertCircle, ShieldCheck, CheckCircle2, ArrowLeft } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { authService } from '@/services/authService'
import { cn } from '@/lib/utils'

// Lazy-load zxcvbn for password strength
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

export function ResetPasswordPage() {
    const [searchParams] = useSearchParams()
    const [token, setToken] = useState(searchParams.get('token') || '')
    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [passwordScore, setPasswordScore] = useState(-1)
    const [passwordFeedback, setPasswordFeedback] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)
    const navigate = useNavigate()
    const { isAuthenticated } = useAuthStore()

    useEffect(() => {
        if (isAuthenticated) navigate('/', { replace: true })
    }, [isAuthenticated, navigate])

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

    const canSubmit = useMemo(() => {
        return token.length > 0
            && password.length >= 8
            && passwordScore >= 3
            && password === confirmPassword
            && !isLoading
    }, [token, password, confirmPassword, passwordScore, isLoading])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!canSubmit) return
        setError(null)
        setIsLoading(true)
        try {
            await authService.resetPassword(token, password)
            setSuccess(true)
        } catch (err: any) {
            setError(err.message || 'Failed to reset password. The token may be invalid or expired.')
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="relative min-h-screen w-full flex items-center justify-center overflow-hidden bg-canvas font-sans">
            {/* Animated Background */}
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

            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                className="relative z-10 w-full max-w-[420px] px-6"
            >
                <div className="glass-panel p-8 md:p-10 rounded-[2rem] border-white/20 dark:border-white/5 shadow-2xl overflow-hidden backdrop-blur-3xl">
                    {/* Logo */}
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
                            Nexus<span className="gradient-text">Lineage</span>
                        </h1>
                        <p className="text-sm text-ink-secondary text-center">
                            {success ? 'Password reset successful' : 'Set your new password'}
                        </p>
                    </div>

                    <AnimatePresence mode="wait">
                        {success ? (
                            <motion.div
                                key="success"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-5"
                            >
                                <div className="flex flex-col items-center text-center py-4">
                                    <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center mb-4">
                                        <CheckCircle2 className="w-7 h-7 text-emerald-500" />
                                    </div>
                                    <p className="text-sm text-ink-secondary leading-relaxed">
                                        Your password has been reset successfully.
                                    </p>
                                    <p className="text-sm text-ink-secondary leading-relaxed mt-1">
                                        You can now sign in with your new password.
                                    </p>
                                </div>
                                <Link
                                    to="/login"
                                    className="w-full h-12 rounded-xl bg-accent-lineage text-white font-semibold shadow-lg shadow-accent-lineage/20 transition-all hover:brightness-110 active:scale-[0.98] flex items-center justify-center gap-2"
                                >
                                    Sign in
                                    <ChevronRight className="w-4 h-4" />
                                </Link>
                            </motion.div>
                        ) : (
                            <motion.form
                                key="form"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                onSubmit={handleSubmit}
                                className="space-y-5"
                            >
                                {/* Reset Token */}
                                <div className="space-y-2">
                                    <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted ml-1" htmlFor="token">
                                        Reset Token
                                    </label>
                                    <div className="relative group">
                                        <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors">
                                            <Key className="w-4 h-4" />
                                        </div>
                                        <input
                                            id="token"
                                            type="text"
                                            placeholder="Paste your reset token here"
                                            value={token}
                                            onChange={(e) => setToken(e.target.value)}
                                            className="input pl-10 h-12 bg-white/50 dark:bg-black/20 border-white/40 dark:border-white/10 font-mono text-sm"
                                            required
                                            autoFocus={!token}
                                        />
                                    </div>
                                    <p className="text-[11px] text-ink-muted ml-1">
                                        Provided by your administrator
                                    </p>
                                </div>

                                {/* New Password */}
                                <div className="space-y-2">
                                    <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted ml-1" htmlFor="password">
                                        New Password
                                    </label>
                                    <div className="relative group">
                                        <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors">
                                            <Lock className="w-4 h-4" />
                                        </div>
                                        <input
                                            id="password"
                                            type="password"
                                            placeholder="New password"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            className="input pl-10 h-12 bg-white/50 dark:bg-black/20 border-white/40 dark:border-white/10"
                                            required
                                            minLength={8}
                                        />
                                    </div>

                                    {/* Strength meter */}
                                    {passwordScore >= 0 && (
                                        <div className="space-y-1.5 px-1">
                                            <div className="flex gap-1 h-1.5">
                                                {[0, 1, 2, 3, 4].map(i => (
                                                    <div
                                                        key={i}
                                                        className={cn(
                                                            "flex-1 rounded-full transition-all duration-300",
                                                            i <= passwordScore
                                                                ? STRENGTH_COLORS[passwordScore]
                                                                : "bg-black/10 dark:bg-white/10"
                                                        )}
                                                    />
                                                ))}
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-[11px] font-medium text-ink-muted">
                                                    {STRENGTH_LABELS[passwordScore]}
                                                </span>
                                                {passwordScore < 3 && (
                                                    <span className="text-[11px] text-amber-500">
                                                        Minimum: Strong
                                                    </span>
                                                )}
                                            </div>
                                            {passwordFeedback && (
                                                <p className="text-[11px] text-ink-muted">{passwordFeedback}</p>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* Confirm Password */}
                                <div className="space-y-2">
                                    <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted ml-1" htmlFor="confirm">
                                        Confirm Password
                                    </label>
                                    <div className="relative group">
                                        <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors">
                                            <Lock className="w-4 h-4" />
                                        </div>
                                        <input
                                            id="confirm"
                                            type="password"
                                            placeholder="Confirm new password"
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            className="input pl-10 h-12 bg-white/50 dark:bg-black/20 border-white/40 dark:border-white/10"
                                            required
                                        />
                                    </div>
                                    {confirmPassword && password !== confirmPassword && (
                                        <p className="text-[11px] text-red-500 ml-1">Passwords do not match</p>
                                    )}
                                </div>

                                {/* Error */}
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

                                {/* Submit */}
                                <button
                                    type="submit"
                                    disabled={!canSubmit}
                                    className={cn(
                                        "w-full h-12 rounded-xl bg-accent-lineage text-white font-semibold shadow-lg shadow-accent-lineage/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2",
                                        !canSubmit ? "opacity-50 cursor-not-allowed" : "hover:brightness-110"
                                    )}
                                >
                                    {isLoading ? (
                                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        <>
                                            Reset Password
                                            <ChevronRight className="w-4 h-4" />
                                        </>
                                    )}
                                </button>
                            </motion.form>
                        )}
                    </AnimatePresence>

                    {/* Footer */}
                    {!success && (
                        <div className="mt-8 text-center space-y-3">
                            <p className="text-xs text-ink-muted">
                                <Link to="/login" className="text-accent-lineage font-semibold hover:underline inline-flex items-center gap-1">
                                    <ArrowLeft className="w-3 h-3" />
                                    Back to sign in
                                </Link>
                            </p>
                        </div>
                    )}
                </div>

                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 1 }}
                    className="mt-6 flex justify-center gap-4 text-[10px] text-ink-muted/60 font-medium uppercase tracking-widest"
                >
                    <span>v0.1.0</span>
                    <span>&bull;</span>
                    <span>&copy; 2026 Nexus Lineage</span>
                </motion.div>
            </motion.div>
        </div>
    )
}
