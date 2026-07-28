/**
 * Where an SSO-redeemed invite lands.
 *
 * The provider handshake proves who you are; it knows nothing about the
 * invitation you were holding. So the invite rides through the SSO
 * flow's own `next` path and is settled here, against the session that
 * handshake just established.
 *
 * That split is deliberate rather than incidental: `backend/auth_service`
 * is being prepared for extraction and may not import the roles, groups
 * and invite ledger that live in `backend/app`. Finishing the redemption
 * on this side keeps the boundary intact — the auth service carries an
 * opaque string it never has to understand.
 */
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, CheckCircle2, ShieldCheck } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { authService } from '@/services/authService'
import { useAuthStore } from '@/store/auth'
import { useBrand } from '@/store/branding'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

export function InviteAcceptPage() {
    const brand = useBrand()
    const [searchParams] = useSearchParams()
    const inviteToken = searchParams.get('invite')
    const navigate = useNavigate()
    const bootstrap = useAuthStore(s => s.bootstrap)

    const [error, setError] = useState<string | null>(null)
    const [done, setDone] = useState<string | null>(null)
    // StrictMode double-invokes effects in development, and redeeming
    // twice would spend two seats off a capped link for one person.
    const started = useRef(false)

    useDocumentTitle('Accepting invite')

    useEffect(() => {
        if (started.current) return
        started.current = true

        void (async () => {
            if (!inviteToken) {
                navigate('/', { replace: true })
                return
            }
            try {
                const res = await authService.redeemInvite(inviteToken)
                // Roles and group memberships were just written, so the
                // session's cached claims are already stale — re-read
                // them before landing, or the first screen renders with
                // the access they had a moment ago (none).
                await bootstrap()
                setDone(res.message)
                navigate(res.redirectTo || '/', { replace: true })
            } catch (err: unknown) {
                setError(
                    err instanceof Error && err.message
                        ? err.message
                        : 'This invite could not be applied.',
                )
            }
        })()
    }, [inviteToken, navigate, bootstrap])

    return (
        <div className="relative min-h-screen w-full flex items-center justify-center bg-canvas font-sans">
            <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="w-full max-w-[420px] px-6 text-center"
            >
                <div className="glass-panel p-8 rounded-[2rem] border-white/20 dark:border-white/5 shadow-2xl">
                    {error ? (
                        <>
                            <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-red-500/10 flex items-center justify-center">
                                <AlertCircle className="w-7 h-7 text-red-500" />
                            </div>
                            <h1 className="text-lg font-bold text-ink mb-1.5">
                                We couldn't apply that invite
                            </h1>
                            <p className="text-sm text-ink-muted leading-relaxed">{error}</p>
                            {/* They ARE signed in — the handshake succeeded, only
                                the invite didn't apply. Offer the app, not a dead end. */}
                            <Link
                                to="/"
                                className="mt-5 inline-block text-sm font-semibold text-accent-lineage hover:underline"
                            >
                                Continue to {brand.appName}
                            </Link>
                        </>
                    ) : done ? (
                        <>
                            <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                                <CheckCircle2 className="w-7 h-7 text-emerald-500" />
                            </div>
                            <p className="text-sm text-ink-secondary" role="status">{done}</p>
                        </>
                    ) : (
                        <>
                            <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-accent-lineage/10 flex items-center justify-center">
                                <ShieldCheck className="w-7 h-7 text-accent-lineage" />
                            </div>
                            <h1 className="text-lg font-bold text-ink mb-1.5">
                                Setting up your access
                            </h1>
                            <p className="text-sm text-ink-muted">
                                One moment — applying your invitation.
                            </p>
                            <div className="mt-5 mx-auto w-5 h-5 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
                        </>
                    )}
                </div>
            </motion.div>
        </div>
    )
}
