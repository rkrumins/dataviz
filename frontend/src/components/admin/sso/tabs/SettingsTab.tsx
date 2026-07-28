/**
 * SettingsTab — the platform-wide SSO posture switches.
 */
import { useCallback, useEffect, useState } from 'react'
import { ShieldOff } from 'lucide-react'

import { ssoAdminService, type AuthConfig } from '@/services/ssoAdminService'
import { ErrorBanner } from './ErrorBanner'

export function SettingsTab() {
    const [cfg, setCfg] = useState<AuthConfig | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [confirm, setConfirm] = useState<keyof AuthConfig | null>(null)

    const refresh = useCallback(async () => {
        try {
            setCfg(await ssoAdminService.getAuthConfig())
            setError(null)
        } catch (err) {
            setError((err as Error).message)
        }
    }, [])

    useEffect(() => { void refresh() }, [refresh])

    async function applyToggle<K extends keyof AuthConfig>(field: K, value: AuthConfig[K]) {
        if (!cfg) return
        setBusy(true)
        try {
            const next = await ssoAdminService.updateAuthConfig({
                [field]: value,
                expectedVersion: cfg.version,
            } as never)
            setCfg(next)
            setError(null)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
            setConfirm(null)
        }
    }

    if (cfg === null && error === null) {
        return <div className="p-4 text-ink-muted text-sm">Loading…</div>
    }

    const toggles: {
        field: keyof AuthConfig
        label: string
        description: string
        destructive: boolean
    }[] = [
        {
            field: 'ssoEnabled',
            label: 'SSO enabled',
            description:
                'Master kill-switch. When off, /auth/providers returns [] and all /auth/{slug}/* routes return 404. Individual provider rows keep their settings; toggling this back on restores them.',
            destructive: false,
        },
        {
            field: 'allowLocalLogin',
            label: 'Allow local login',
            description:
                'When off, POST /auth/login returns 403 (SSO-only mode). Refused if it would lock out any active admin without an SSO identity.',
            destructive: true,
        },
        {
            field: 'allowJitProvisioning',
            label: 'Allow JIT provisioning',
            description:
                'When off, SSO logins for unknown subjects raise jit_disabled instead of creating a new user. Existing users keep working; admins must pre-create accounts (or invite).',
            destructive: false,
        },
        {
            field: 'emailFirstLogin',
            label: 'Email-first sign-in',
            description:
                'Ask for an email address first and route to the matching provider, instead of showing every provider as a button. Set each provider’s email domains before turning this on — an address that matches nothing falls back to the password form, so nobody is stranded.',
            destructive: false,
        },
    ]

    return (
        <div className="space-y-4">
            {error && <ErrorBanner message={error} />}
            <h2 className="text-base font-semibold">Platform SSO posture</h2>
            <p className="text-xs text-ink-muted">
                Version {cfg?.version ?? '—'} · last updated {cfg?.updatedAt ?? '—'}
            </p>
            <div className="space-y-3">
                {toggles.map((t) => {
                    const value = cfg ? (cfg[t.field] as boolean) : false
                    const wantsConfirm = t.destructive && value
                    return (
                        <div
                            key={t.field}
                            className="p-4 rounded-xl border border-white/10 bg-white/5 flex items-start gap-4"
                        >
                            <button
                                disabled={busy || cfg === null}
                                onClick={() => {
                                    if (wantsConfirm) {
                                        setConfirm(t.field)
                                    } else {
                                        void applyToggle(t.field, !value as never)
                                    }
                                }}
                                className={`mt-0.5 w-10 h-6 rounded-full transition-colors ${value ? 'bg-emerald-500' : 'bg-ink-muted/30'} disabled:opacity-50`}
                                aria-pressed={value}
                                aria-label={t.label}
                            >
                                <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${value ? 'translate-x-4' : 'translate-x-0.5'}`} />
                            </button>
                            <div className="flex-1">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    {t.label}
                                    {value ? null : (
                                        <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-300">
                                            OFF
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 text-xs text-ink-muted">
                                    {t.description}
                                </p>
                                {confirm === t.field && (
                                    <div className="mt-3 p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-sm">
                                        <div className="flex items-center gap-2 font-medium text-red-200">
                                            <ShieldOff className="w-4 h-4" />
                                            Confirm
                                        </div>
                                        <p className="mt-1 text-xs">
                                            This change is restrictive. Server-side
                                            lockout safeguards still apply (admins
                                            without an SSO identity will block the
                                            change with HTTP 409).
                                        </p>
                                        <div className="mt-2 flex gap-2">
                                            <button
                                                onClick={() => applyToggle(t.field, !value as never)}
                                                className="px-3 py-1.5 text-xs rounded bg-red-500 text-white"
                                            >
                                                Confirm change
                                            </button>
                                            <button
                                                onClick={() => setConfirm(null)}
                                                className="px-3 py-1.5 text-xs rounded border border-white/20"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
