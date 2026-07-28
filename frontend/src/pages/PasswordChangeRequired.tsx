/**
 * PasswordChangeRequired — the wall in front of an account that is
 * still holding a shipped default password.
 *
 * Deliberately outside AppLayout and deliberately without an exit: the
 * API refuses everything except this form, so offering navigation would
 * only lead to a wall of 403s.
 *
 * The credential this catches — `admin123` / `changeme` — is printed in
 * the README, the quickstart compose file, and every setup doc, so an
 * unrotated bootstrap admin is a publicly known password on a
 * super_admin account.
 */
import { useState } from 'react'
import { AlertCircle, KeyRound, ShieldAlert } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import {
    STRENGTH_COLORS, STRENGTH_LABELS, MIN_STRENGTH_SCORE, usePasswordStrength,
} from '@/lib/passwordStrength'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { cn } from '@/lib/utils'
import { accountService } from '@/services/accountService'
import { useAuthStore } from '@/store/auth'

export function PasswordChangeRequired() {
    useDocumentTitle('Choose a new password')

    const navigate = useNavigate()
    const logout = useAuthStore((s) => s.logout)
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const { score, feedback } = usePasswordStrength(newPassword)

    const canSubmit = currentPassword.length > 0
        && newPassword.length >= 8
        && score >= MIN_STRENGTH_SCORE
        && newPassword === confirmPassword
        && !saving

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!canSubmit) return
        setSaving(true)
        setError(null)
        try {
            await accountService.changePassword(currentPassword, newPassword)
            // The change revokes every session, this one included.
            await logout()
            navigate('/login', { replace: true })
        } catch (err) {
            setError((err as Error).message)
            setSaving(false)
        }
    }

    return (
        <div className="min-h-screen w-full flex items-center justify-center bg-canvas px-4 py-10">
            <div className="w-full max-w-md">
                <div className="flex items-start gap-3 mb-6">
                    <div className="w-11 h-11 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                        <ShieldAlert className="w-5 h-5 text-amber-500" />
                    </div>
                    <div>
                        <h1 className="text-xl font-semibold text-ink">
                            Choose a new password
                        </h1>
                        <p className="text-sm text-ink-secondary mt-1">
                            This account is still using the password it shipped with.
                            That password is published in this project's setup
                            documentation, so anyone who can reach this deployment
                            already knows it.
                        </p>
                    </div>
                </div>

                <form
                    onSubmit={handleSubmit}
                    className="rounded-2xl border border-glass-border bg-canvas-elevated p-6 space-y-5"
                >
                    <PasswordField
                        label="Current password"
                        value={currentPassword}
                        onChange={setCurrentPassword}
                    />

                    <div>
                        <PasswordField
                            label="New password"
                            value={newPassword}
                            onChange={setNewPassword}
                        />
                        {newPassword.length > 0 && score >= 0 && (
                            <div className="mt-2">
                                <div className="flex gap-1">
                                    {[0, 1, 2, 3, 4].map((i) => (
                                        <div
                                            key={i}
                                            className={cn(
                                                'h-1 flex-1 rounded-full transition-colors',
                                                i <= score
                                                    ? STRENGTH_COLORS[score]
                                                    : 'bg-black/10 dark:bg-white/10',
                                            )}
                                        />
                                    ))}
                                </div>
                                <div className="flex items-start justify-between mt-1.5 gap-2">
                                    <p className="text-[11px] text-ink-muted">
                                        {STRENGTH_LABELS[score]}
                                    </p>
                                    <p className="text-[11px] text-ink-muted">
                                        Minimum: {STRENGTH_LABELS[MIN_STRENGTH_SCORE]}
                                    </p>
                                </div>
                                {score < MIN_STRENGTH_SCORE && feedback && (
                                    <p className="text-[11px] text-ink-muted mt-1">{feedback}</p>
                                )}
                            </div>
                        )}
                    </div>

                    <PasswordField
                        label="Confirm new password"
                        value={confirmPassword}
                        onChange={setConfirmPassword}
                        help={
                            confirmPassword.length > 0 && confirmPassword !== newPassword
                                ? 'These do not match.'
                                : ''
                        }
                    />

                    {error && (
                        <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
                            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={!canSubmit}
                        className={cn(
                            'w-full px-4 py-2.5 rounded-xl font-medium text-sm text-white',
                            'bg-accent-lineage hover:brightness-110 transition-colors',
                            'shadow-sm shadow-accent-lineage/20 flex items-center justify-center gap-2',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                    >
                        <KeyRound className="w-4 h-4" />
                        {saving ? 'Saving…' : 'Set new password'}
                    </button>

                    <p className="text-[11px] text-ink-muted text-center">
                        You will be signed out and asked to sign in again with the
                        new password.
                    </p>
                </form>
            </div>
        </div>
    )
}

function PasswordField({
    label, value, onChange, help,
}: {
    label: string
    value: string
    onChange: (v: string) => void
    help?: string
}) {
    return (
        <label className="block">
            <span className="text-xs font-semibold text-ink-secondary">{label}</span>
            <input
                type="password"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className={cn(
                    'mt-1.5 w-full px-3 py-2 rounded-lg border border-glass-border bg-canvas',
                    'text-ink text-sm',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-shadow',
                )}
            />
            {help && <span className="block text-[11px] text-ink-muted mt-1">{help}</span>}
        </label>
    )
}
