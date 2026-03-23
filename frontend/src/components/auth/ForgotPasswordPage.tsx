/**
 * ForgotPasswordPage — user enters their email to request a password reset.
 *
 * The backend always returns 200 (prevents email enumeration).
 * An outbox event is created for the admin panel to surface.
 * The user is told to contact their admin for the reset token.
 */
import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AtSign, ChevronRight, AlertCircle, ShieldCheck, CheckCircle2, ArrowLeft } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { authService } from '@/services/authService'
import { cn } from '@/lib/utils'

export function ForgotPasswordPage() {
    const [email, setEmail] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [submitted, setSubmitted] = useState(false)
    const navigate = useNavigate()
    const { isAuthenticated } = useAuthStore()

    useEffect(() => {
        if (isAuthenticated) navigate('/', { replace: true })
    }, [isAuthenticated, navigate])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!email || isLoading) return
        setError(null)
        setIsLoading(true)
        try {
            await authService.forgotPassword(email)
            setSubmitted(true)
        } catch (err: any) {
            setError(err.message || 'Something went wrong. Please try again.')
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
                            {submitted ? 'Reset request submitted' : 'Reset your password'}
                        </p>
                    </div>

                    <AnimatePresence mode="wait">
                        {submitted ? (
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
                                    <p className="text-sm text-ink-secondary leading-relaxed max-w-[280px]">
                                        If an account exists for <strong className="text-ink">{email}</strong>, a password reset has been initiated.
                                    </p>
                                    <p className="text-sm text-ink-secondary leading-relaxed mt-3 max-w-[280px]">
                                        Contact your administrator for the reset token, then use it on the reset page.
                                    </p>
                                </div>

                                <div className="flex flex-col gap-3">
                                    <Link
                                        to="/reset-password"
                                        className="w-full h-12 rounded-xl bg-accent-lineage text-white font-semibold shadow-lg shadow-accent-lineage/20 transition-all hover:brightness-110 active:scale-[0.98] flex items-center justify-center gap-2"
                                    >
                                        I have a reset token
                                        <ChevronRight className="w-4 h-4" />
                                    </Link>
                                    <Link
                                        to="/login"
                                        className="w-full h-12 rounded-xl border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 text-ink font-semibold transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                                    >
                                        <ArrowLeft className="w-4 h-4" />
                                        Back to sign in
                                    </Link>
                                </div>
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
                                <p className="text-sm text-ink-muted text-center -mt-4 mb-2">
                                    Enter your email and we'll notify your administrator to issue a reset token.
                                </p>

                                <div className="space-y-2">
                                    <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted ml-1" htmlFor="email">
                                        Email Address
                                    </label>
                                    <div className="relative group">
                                        <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors">
                                            <AtSign className="w-4 h-4" />
                                        </div>
                                        <input
                                            id="email"
                                            type="email"
                                            placeholder="your@email.com"
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            className="input pl-10 h-12 bg-white/50 dark:bg-black/20 border-white/40 dark:border-white/10"
                                            required
                                            autoFocus
                                        />
                                    </div>
                                </div>

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
                                            Request Reset
                                            <ChevronRight className="w-4 h-4" />
                                        </>
                                    )}
                                </button>
                            </motion.form>
                        )}
                    </AnimatePresence>

                    {/* Footer */}
                    {!submitted && (
                        <div className="mt-8 text-center space-y-3">
                            <p className="text-xs text-ink-muted">
                                Remember your password?{' '}
                                <Link to="/login" className="text-accent-lineage font-semibold hover:underline">
                                    Sign in
                                </Link>
                            </p>
                            <p className="text-xs text-ink-muted">
                                Already have a reset token?{' '}
                                <Link to="/reset-password" className="text-accent-lineage font-semibold hover:underline">
                                    Reset password
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
