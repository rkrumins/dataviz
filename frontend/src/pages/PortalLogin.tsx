/**
 * Portal-Login page — the landing spot for a ``custom_profile`` provider
 * whose profile lives in browser storage.
 *
 * The backend can't read localStorage, so ``GET /api/v1/auth/{slug}/login``
 * 302s here instead of completing the login itself. This page reads the
 * configured storage key, POSTs it to ``/auth/{slug}/browser-profile``,
 * and navigates on to ``next`` once the session cookies come back.
 *
 * It matters most for the 24h SSO re-auth bounce: ``tryRefresh`` sends the
 * browser to ``/auth/{slug}/login?force=1``, which lands here, which
 * re-establishes the session and returns the user to where they were.
 *
 * Everything is verified server-side — this page is transport only and
 * never inspects or trusts the payload it forwards.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertCircle, ShieldCheck } from 'lucide-react'
import {
    authService,
    needsBrowserPayload,
    readBrowserProfile,
    type SsoProviderSummary,
} from '@/services/authService'
import { useAuthStore } from '@/store/auth'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

type Phase = 'resolving' | 'signing-in' | 'error'

export function PortalLogin() {
    const [params] = useSearchParams()
    const navigate = useNavigate()
    const loginWithBrowserProfile = useAuthStore((s) => s.loginWithBrowserProfile)

    const slug = params.get('slug') ?? ''
    const nextPath = useMemo(() => {
        const raw = params.get('next') ?? '/dashboard'
        // Same-origin relative paths only — mirrors the backend's
        // ``_safe_next`` open-redirect guard.
        return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard'
    }, [params])

    useDocumentTitle('Signing in')

    // A missing slug is knowable at first render, so derive it rather
    // than setting state from the effect.
    const [phase, setPhase] = useState<Phase>(slug ? 'resolving' : 'error')
    const [message, setMessage] = useState<string | null>(
        slug ? null : 'No provider was specified for this sign-in.',
    )
    const [provider, setProvider] = useState<SsoProviderSummary | null>(null)
    const started = useRef(false)

    const attempt = useCallback(async (p: SsoProviderSummary) => {
        const payload = readBrowserProfile(p)
        if (!payload) {
            setPhase('error')
            setMessage(
                `No ${p.displayName} session was found in this browser. ` +
                'Sign in to the portal, then retry.',
            )
            return
        }
        setPhase('signing-in')
        setMessage(null)
        const ok = await loginWithBrowserProfile(p.slug, payload)
        if (ok) {
            navigate(nextPath, { replace: true })
            return
        }
        setPhase('error')
        setMessage(
            useAuthStore.getState().error ??
            'The portal profile was rejected. Contact your administrator.',
        )
    }, [loginWithBrowserProfile, navigate, nextPath])

    useEffect(() => {
        if (started.current) return
        started.current = true

        if (!slug) return
        void authService.listProviders()
            .then((rows) => {
                const match = rows.find((r) => r.slug === slug)
                if (!match || !needsBrowserPayload(match)) {
                    setPhase('error')
                    setMessage(
                        'This sign-in method is not available. It may have ' +
                        'been disabled by an administrator.',
                    )
                    return
                }
                setProvider(match)
                return attempt(match)
            })
            .catch(() => {
                setPhase('error')
                setMessage('Could not reach the sign-in service. Try again.')
            })
    }, [slug, attempt])

    return (
        <div className="min-h-screen w-full flex items-center justify-center bg-canvas font-sans px-6">
            <div className="w-full max-w-[420px] glass-panel p-8 rounded-[2rem] border-white/20 dark:border-white/5 shadow-2xl">
                <div className="flex flex-col items-center text-center">
                    <div className="w-14 h-14 mb-5 rounded-2xl bg-gradient-to-br from-accent-lineage to-accent-lineage/80 flex items-center justify-center shadow-lg shadow-accent-lineage/30">
                        <ShieldCheck className="w-7 h-7 text-white" />
                    </div>

                    {phase !== 'error' ? (
                        <>
                            <h1 className="text-lg font-semibold text-ink">
                                {phase === 'signing-in'
                                    ? `Signing in with ${provider?.displayName ?? 'your portal'}…`
                                    : 'Preparing sign-in…'}
                            </h1>
                            <div className="mt-6 w-7 h-7 border-2 border-ink-muted/30 border-t-accent-lineage rounded-full animate-spin" />
                        </>
                    ) : (
                        <>
                            <h1 className="text-lg font-semibold text-ink">
                                Sign-in didn't complete
                            </h1>
                            <div className="mt-4 flex items-start gap-2 p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20 text-yellow-300 text-sm text-left">
                                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                <p>{message}</p>
                            </div>
                            <div className="mt-6 flex gap-2 w-full">
                                {provider && (
                                    <button
                                        type="button"
                                        onClick={() => { void attempt(provider) }}
                                        className="flex-1 py-2.5 rounded-xl bg-accent-lineage text-white text-sm font-semibold hover:brightness-110 transition-all"
                                    >
                                        Retry
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => navigate('/login', { replace: true })}
                                    className="flex-1 py-2.5 rounded-xl border border-white/20 text-ink text-sm font-medium hover:bg-white/5 transition-colors"
                                >
                                    Use another method
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
