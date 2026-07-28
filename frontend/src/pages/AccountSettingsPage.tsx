/**
 * AccountSettingsPage — manage your own account.
 *
 * Everything account-shaped in this product was previously something an
 * administrator did to somebody else: Admin → Users could rename you,
 * reset your password, suspend you. There was no screen where you could
 * do any of it yourself, which for the sole System Administrator meant
 * editing your own row through a table built for managing other people.
 *
 * Shell copied from MyIdentitiesPage — including the `absolute inset-0
 * overflow-y-auto` wrapper, which is load-bearing: AppLayout gives its
 * outlet `overflow-hidden`, so pages scroll themselves.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
    AlertCircle, Clock, Image as ImageIcon, KeyRound, Link2,
    LogOut, ShieldCheck, UserCircle,
} from 'lucide-react'

import { PageContainer } from '@/components/layout/PageContainer'
import { AvatarPickerDialog } from '@/components/layout/AvatarPickerDialog'
import { useToast } from '@/components/ui/toast'
import {
    STRENGTH_COLORS, STRENGTH_LABELS, MIN_STRENGTH_SCORE, usePasswordStrength,
} from '@/lib/passwordStrength'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { cn } from '@/lib/utils'
import { accountService, type AccountActivityItem } from '@/services/accountService'
import { authService } from '@/services/authService'
import { useAuthStore } from '@/store/auth'
import { usePreferencesStore } from '@/store/preferences'

/** What each activity event is called, in words the account owner uses. */
const ACTIVITY_LABELS: Record<string, string> = {
    'user.password_changed': 'You changed your password',
    'user.password_reset_by_admin': 'An administrator reset your password',
    'user.password_reset_completed': 'Your password was reset with a token',
    'user.reset_token_generated': 'A password reset token was issued',
    'user.identity_updated': 'Your profile was updated',
    'user.sessions_revoked_by_self': 'You signed out on every device',
    'user.session_revoked': 'Your sessions were signed out',
    'user.role_changed': 'Your access level changed',
    'user.suspended': 'Your account was suspended',
    'user.reactivated': 'Your account was reactivated',
}

export function AccountSettingsPage() {
    useDocumentTitle('Account settings')

    const navigate = useNavigate()
    const { showToast } = useToast()
    // Never null here: AppLayout redirects unauthenticated visitors.
    const user = useAuthStore((s) => s.user)
    const applyProfile = useAuthStore((s) => s.applyProfile)
    // The picker writes straight to the preferences store, which is
    // browser-local. We read the result back on close and persist it,
    // so the choice follows the account instead of the machine.
    const avatarId = usePreferencesStore((s) => s.avatarId)

    // ── Profile ──────────────────────────────────────────────────────
    const [firstName, setFirstName] = useState(user?.firstName ?? '')
    const [lastName, setLastName] = useState(user?.lastName ?? '')
    const [displayName, setDisplayName] = useState('')
    const [savingProfile, setSavingProfile] = useState(false)
    const [avatarOpen, setAvatarOpen] = useState(false)

    // ── Password ─────────────────────────────────────────────────────
    const [passwordSet, setPasswordSet] = useState<boolean | null>(null)
    const [providerName, setProviderName] = useState<string | null>(null)
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [passwordError, setPasswordError] = useState<string | null>(null)
    const [savingPassword, setSavingPassword] = useState(false)
    const { score, feedback } = usePasswordStrength(newPassword)

    // ── Sessions + activity ──────────────────────────────────────────
    const [revoking, setRevoking] = useState(false)
    const [activity, setActivity] = useState<AccountActivityItem[]>([])

    // One fetch for the stored profile (the session user predates any
    // edit made in another tab), one for whether a password exists at
    // all, one for the history.
    useEffect(() => {
        let cancelled = false
        void (async () => {
            try {
                const profile = await accountService.getProfile()
                if (cancelled) return
                setFirstName(profile.firstName)
                setLastName(profile.lastName)
                // The server sends the *resolved* name. Only show it as
                // an override when it differs from the derived one —
                // otherwise clearing the box would look like a no-op.
                const derived = `${profile.firstName} ${profile.lastName}`.trim()
                setDisplayName(profile.displayName === derived ? '' : profile.displayName)
            } catch {
                /* the seeded session values stand in */
            }
            try {
                const identities = await authService.listMyIdentities()
                if (cancelled) return
                setPasswordSet(identities.passwordSet)
                setProviderName(identities.identities[0]?.provider.displayName ?? null)
            } catch {
                if (!cancelled) setPasswordSet(true)
            }
            try {
                const rows = await accountService.listActivity()
                if (!cancelled) setActivity(rows)
            } catch {
                /* activity is supplementary — never block the page on it */
            }
        })()
        return () => { cancelled = true }
    }, [])

    const derivedName = `${firstName} ${lastName}`.trim()
    const initials = `${(firstName[0] ?? '').toUpperCase()}${(lastName[0] ?? '').toUpperCase()}`
    const profileDirty = useMemo(() => (
        firstName.trim() !== (user?.firstName ?? '')
        || lastName.trim() !== (user?.lastName ?? '')
        || displayName.trim() !== ''
    ), [firstName, lastName, displayName, user])

    const canSaveProfile = !!firstName.trim() && !!lastName.trim()
        && profileDirty && !savingProfile

    const handleSaveProfile = async () => {
        if (!canSaveProfile) return
        setSavingProfile(true)
        try {
            const updated = await accountService.updateProfile({
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                // Always sent, so clearing the box actually clears the
                // override rather than silently leaving the old one.
                displayName: displayName.trim(),
            })
            applyProfile({
                firstName: updated.firstName,
                lastName: updated.lastName,
                displayName: updated.displayName,
            })
            showToast('success', 'Profile updated')
        } catch (err) {
            showToast('error', (err as Error).message)
        } finally {
            setSavingProfile(false)
        }
    }

    const canSubmitPassword = currentPassword.length > 0
        && newPassword.length >= 8
        && score >= MIN_STRENGTH_SCORE
        && newPassword === confirmPassword
        && !savingPassword

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!canSubmitPassword) return
        setSavingPassword(true)
        setPasswordError(null)
        try {
            await accountService.changePassword(currentPassword, newPassword)
            // The session that made this request is gone — the server
            // revoked it along with every other one. Go to the login
            // page rather than letting the next click 401.
            showToast('success', 'Password changed. Sign in again.')
            navigate('/login', { replace: true })
        } catch (err) {
            setPasswordError((err as Error).message)
        } finally {
            setSavingPassword(false)
        }
    }

    const handleRevokeAll = async () => {
        setRevoking(true)
        try {
            await accountService.revokeAllSessions()
            navigate('/login', { replace: true })
        } catch (err) {
            showToast('error', (err as Error).message)
            setRevoking(false)
        }
    }

    const handleAvatarDialogClosed = async () => {
        setAvatarOpen(false)
        if (avatarId === (user?.avatarId ?? null)) return
        try {
            await accountService.updateProfile({ avatarId: avatarId ?? '' })
            applyProfile({ avatarId })
        } catch (err) {
            // The local preference already applied, so it looks right
            // on this screen. Say plainly that it won't follow them.
            showToast('error', `Avatar saved on this device only: ${(err as Error).message}`)
        }
    }

    return (
        <div className="absolute inset-0 overflow-y-auto bg-canvas">
            <PageContainer width="narrow" className="py-8 space-y-8">
                <header>
                    <h1 className="text-2xl font-semibold text-ink">Account settings</h1>
                    <p className="mt-2 text-sm text-ink-secondary">
                        Your name, your password, and the devices you are signed in on.
                    </p>
                </header>

                {/* ── Profile ── */}
                <Section
                    icon={UserCircle}
                    title="Profile"
                    blurb="How your name appears to everyone else."
                >
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Field
                            label="First name"
                            help=""
                            value={firstName}
                            onChange={setFirstName}
                        />
                        <Field
                            label="Last name"
                            help=""
                            value={lastName}
                            onChange={setLastName}
                        />
                    </div>

                    <Field
                        label="Display name"
                        help={
                            displayName.trim()
                                ? 'Shown instead of your first and last name.'
                                : `Leave blank to use “${derivedName || 'your name'}”.`
                        }
                        value={displayName}
                        onChange={setDisplayName}
                        placeholder={derivedName}
                    />

                    <div>
                        <span className="text-xs font-semibold text-ink-secondary">Email</span>
                        <input
                            type="email"
                            value={user?.email ?? ''}
                            disabled
                            className={cn(
                                'mt-1.5 w-full px-3 py-2 rounded-lg border border-glass-border bg-canvas',
                                'text-ink-muted text-sm cursor-not-allowed',
                            )}
                        />
                        <span className="block text-[11px] text-ink-muted mt-1">
                            Your email identifies you to your identity provider, so an
                            administrator has to change it.
                        </span>
                    </div>

                    <div className="flex items-center justify-between gap-3 pt-1">
                        <button
                            type="button"
                            onClick={() => setAvatarOpen(true)}
                            className="px-3 py-2 rounded-lg text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-2"
                        >
                            <ImageIcon className="w-4 h-4" />
                            Change avatar
                        </button>
                        <button
                            type="button"
                            onClick={handleSaveProfile}
                            disabled={!canSaveProfile}
                            className={cn(
                                'px-4 py-2 rounded-xl font-medium text-sm text-white bg-accent-lineage',
                                'hover:brightness-110 transition-colors duration-150',
                                'shadow-sm shadow-accent-lineage/20',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                            )}
                        >
                            {savingProfile ? 'Saving…' : 'Save changes'}
                        </button>
                    </div>
                </Section>

                {/* ── Password ── */}
                <Section
                    icon={KeyRound}
                    title="Password"
                    blurb="Changing it signs you out everywhere, including here."
                >
                    {passwordSet === false ? (
                        <div className="p-4 rounded-xl border border-glass-border bg-canvas text-sm text-ink-secondary space-y-2">
                            <p>
                                You sign in with {providerName ?? 'your identity provider'}.
                                There is no password on this account to change.
                            </p>
                            <p className="text-ink-muted text-[13px]">
                                If you need one — to sign in when the provider is
                                unavailable, say — an administrator can set it for you.
                            </p>
                            <Link
                                to="/me/identities"
                                className="inline-flex items-center gap-1.5 text-accent-lineage hover:underline text-[13px]"
                            >
                                <Link2 className="w-3.5 h-3.5" />
                                Manage connected identities
                            </Link>
                        </div>
                    ) : (
                        <form onSubmit={handleChangePassword} className="space-y-5">
                            <Field
                                label="Current password"
                                help=""
                                type="password"
                                value={currentPassword}
                                onChange={setCurrentPassword}
                            />
                            <div>
                                <Field
                                    label="New password"
                                    help=""
                                    type="password"
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
                            <Field
                                label="Confirm new password"
                                help={
                                    confirmPassword.length > 0 && confirmPassword !== newPassword
                                        ? 'These do not match.'
                                        : ''
                                }
                                type="password"
                                value={confirmPassword}
                                onChange={setConfirmPassword}
                            />

                            {passwordError && (
                                <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
                                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                                    <span>{passwordError}</span>
                                </div>
                            )}

                            <div className="flex items-center justify-end">
                                <button
                                    type="submit"
                                    disabled={!canSubmitPassword}
                                    className={cn(
                                        'px-4 py-2 rounded-xl font-medium text-sm text-white bg-accent-lineage',
                                        'hover:brightness-110 transition-colors duration-150',
                                        'shadow-sm shadow-accent-lineage/20',
                                        'disabled:opacity-50 disabled:cursor-not-allowed',
                                    )}
                                >
                                    {savingPassword ? 'Changing…' : 'Change password'}
                                </button>
                            </div>
                        </form>
                    )}
                </Section>

                {/* ── Sessions ── */}
                <Section
                    icon={ShieldCheck}
                    title="Signed-in devices"
                    blurb="If you think somebody else has your session, end them all."
                >
                    <div className="flex items-start justify-between gap-4">
                        <p className="text-[13px] text-ink-muted">
                            Signs out every browser and device this account is signed in
                            on — this one included. You will need to sign in again.
                        </p>
                        <button
                            type="button"
                            onClick={handleRevokeAll}
                            disabled={revoking}
                            className={cn(
                                'shrink-0 px-4 py-2 rounded-xl font-medium text-sm',
                                'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20',
                                'hover:bg-red-500/20 transition-colors disabled:opacity-50',
                                'flex items-center gap-2',
                            )}
                        >
                            <LogOut className="w-4 h-4" />
                            {revoking ? 'Signing out…' : 'Sign out everywhere'}
                        </button>
                    </div>
                </Section>

                {/* ── Activity ── */}
                <Section
                    icon={Clock}
                    title="Recent activity"
                    blurb="Security changes on your account."
                >
                    {activity.length === 0 ? (
                        <p className="text-[13px] text-ink-muted">
                            Nothing recorded yet. This history starts from the point
                            your deployment was upgraded, so it will not show anything
                            that happened before then.
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {activity.map((row) => (
                                <li
                                    key={row.id}
                                    className="flex items-center justify-between gap-3 py-2 border-b border-glass-border last:border-0"
                                >
                                    <span className="text-[13px] text-ink">
                                        {ACTIVITY_LABELS[row.eventType] ?? row.eventType}
                                        {row.byAdmin && (
                                            <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                                BY AN ADMIN
                                            </span>
                                        )}
                                    </span>
                                    <time className="text-[11px] text-ink-muted shrink-0">
                                        {new Date(row.occurredAt).toLocaleString()}
                                    </time>
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>

                <nav className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
                    <Link to="/me/identities" className="text-accent-lineage hover:underline inline-flex items-center gap-1.5">
                        <Link2 className="w-3.5 h-3.5" />
                        Connected identities
                    </Link>
                    <Link to="/my/access" className="text-accent-lineage hover:underline inline-flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        What I can access
                    </Link>
                </nav>
            </PageContainer>

            <AvatarPickerDialog
                isOpen={avatarOpen}
                onClose={handleAvatarDialogClosed}
                initials={initials}
            />
        </div>
    )
}

// ── Building blocks ─────────────────────────────────────────────────
//
// Copied from AdminBranding rather than exported from it: they are
// module-private there, and rewiring an admin page to share ~50 lines
// of presentational markup buys less than it costs.

function Section({
    icon: Icon, title, blurb, children,
}: {
    icon: typeof UserCircle
    title: string
    blurb: string
    children: React.ReactNode
}) {
    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-6">
            <div className="flex items-start gap-3 mb-5">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/10 flex items-center justify-center shrink-0">
                    <Icon className="w-4.5 h-4.5 text-indigo-500" />
                </div>
                <div>
                    <h2 className="text-sm font-bold text-ink">{title}</h2>
                    <p className="text-xs text-ink-muted mt-0.5">{blurb}</p>
                </div>
            </div>
            <div className="space-y-5">{children}</div>
        </section>
    )
}

function Field({
    label, help, value, onChange, placeholder, type = 'text',
}: {
    label: string
    help: string
    value: string
    onChange: (v: string) => void
    placeholder?: string
    type?: string
}) {
    return (
        <label className="block">
            <span className="text-xs font-semibold text-ink-secondary">{label}</span>
            <input
                type={type}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                className={cn(
                    'mt-1.5 w-full px-3 py-2 rounded-lg border border-glass-border bg-canvas',
                    'text-ink text-sm placeholder:text-ink-muted/60',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-shadow',
                )}
            />
            {help && <span className="block text-[11px] text-ink-muted mt-1">{help}</span>}
        </label>
    )
}
