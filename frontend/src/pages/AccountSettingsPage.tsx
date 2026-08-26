/**
 * AccountSettingsPage — your own name, password and sessions.
 *
 * Everything account-shaped in this product used to be something an
 * administrator did to somebody else: Admin → Users could rename you,
 * reset your password, suspend you. There was no screen where you could
 * do any of it yourself.
 *
 * Chrome — the identity rail, the navigation, the width — belongs to
 * AccountShell, which every account page shares. What is left here is
 * the three things you can actually change.
 *
 * Two rules shape the rest:
 *
 * **Provenance is visible.** When an identity provider owns a field it
 * is shown locked and attributed, because the alternative is an
 * editable-looking input whose value silently reverts at the next
 * sign-in. The lock is per field, not per account: a directory that
 * releases a first name but no surname owns only the first.
 *
 * **Nothing destructive sits next to Save.** The password form stays
 * collapsed until asked for — expanded, it was the largest thing on the
 * page — and signing out everywhere lives in its own card.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    AlertCircle, Check, ChevronRight, Clock, KeyRound, Lock, LogOut,
    PencilLine, ShieldCheck, X,
} from 'lucide-react'

import { AccountCard, AccountShell, EmptyState, useAccountIdentity } from '@/components/account/AccountShell'
import { pageGeometry } from '@/components/layout/PageContainer'
import { useToast } from '@/components/ui/toast'
import {
    STRENGTH_COLORS, STRENGTH_LABELS, MIN_STRENGTH_SCORE, usePasswordStrength,
} from '@/lib/passwordStrength'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { cn } from '@/lib/utils'
import { accountService, type AccountActivityItem } from '@/services/accountService'
import { authService } from '@/services/authService'
import { useAuthStore } from '@/store/auth'

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

    return (
        <AccountShell
            title="Account settings"
            blurb="Your name, your password, and the devices you are signed in on."
        >
            <AccountSettingsContent />
        </AccountShell>
    )
}

/**
 * Split from the page so it renders *inside* AccountShell rather than
 * beside it. `useAccountIdentity` reads a context the shell provides,
 * and a component cannot consume context from its own child — as the
 * page did briefly, silently reading the default and deciding every
 * account had no password.
 */
function AccountSettingsContent() {
    const navigate = useNavigate()
    const { showToast } = useToast()
    const user = useAuthStore((s) => s.user)
    const applyProfile = useAuthStore((s) => s.applyProfile)
    const logout = useAuthStore((s) => s.logout)
    const { passwordSet, identities } = useAccountIdentity()

    const [firstName, setFirstName] = useState(user?.firstName ?? '')
    const [lastName, setLastName] = useState(user?.lastName ?? '')
    const [displayName, setDisplayName] = useState('')
    const [savingProfile, setSavingProfile] = useState(false)

    const [managedFields, setManagedFields] = useState<string[]>([])
    const [managedBy, setManagedBy] = useState<string | null>(null)

    const [passwordOpen, setPasswordOpen] = useState(false)
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [passwordError, setPasswordError] = useState<string | null>(null)
    const [savingPassword, setSavingPassword] = useState(false)
    const { score, feedback } = usePasswordStrength(newPassword)

    const [revoking, setRevoking] = useState(false)
    const [activity, setActivity] = useState<AccountActivityItem[]>([])

    // The SSO-only card's "Request a password" affordance. The request
    // is the forgot-password flow, which never mints a token — it flags
    // the account so an administrator can grant one deliberately.
    const [requestingPassword, setRequestingPassword] = useState(false)
    const [passwordRequested, setPasswordRequested] = useState(false)

    async function handleRequestPassword() {
        if (!user?.email) return
        setRequestingPassword(true)
        try {
            await authService.forgotPassword(user.email)
            setPasswordRequested(true)
        } catch {
            showToast('error', 'Could not send the request. Try again.')
        } finally {
            setRequestingPassword(false)
        }
    }

    useEffect(() => {
        let cancelled = false
        void (async () => {
            try {
                const profile = await accountService.getProfile()
                if (cancelled) return
                setFirstName(profile.firstName)
                setLastName(profile.lastName)
                setManagedFields(profile.idpManagedFields ?? [])
                setManagedBy(profile.idpManagedBy ?? null)
                // The server sends the *resolved* name. Only treat it as
                // an override when it differs from the derived one, or
                // clearing the box would look like it did nothing.
                const derived = `${profile.firstName} ${profile.lastName}`.trim()
                setDisplayName(profile.displayName === derived ? '' : profile.displayName)
            } catch {
                /* the seeded session values stand in */
            }
            try {
                const rows = await accountService.listActivity()
                if (!cancelled) setActivity(rows)
            } catch {
                /* supplementary — never block the page on it */
            }
        })()
        return () => { cancelled = true }
    }, [])

    /** Provider display name for a managed field, via the identities join. */
    const managingProvider = useMemo(() => (
        identities.find((i) => i.provider.id === managedBy)?.provider.displayName
        ?? (managedBy ? 'your identity provider' : null)
    ), [identities, managedBy])

    const owns = (field: string) => managedFields.includes(field)
    const derivedName = `${firstName} ${lastName}`.trim()

    const profileDirty = useMemo(() => (
        firstName.trim() !== (user?.firstName ?? '')
        || lastName.trim() !== (user?.lastName ?? '')
        || displayName.trim() !== ''
    ), [firstName, lastName, displayName, user])

    // A first name is required; a surname is not — "Prince" and
    // undivided scripts ("山田太郎") land whole in the first name, and
    // demanding a second field made Save permanently dead for them
    // (taking the display-name escape hatch down with it, since it
    // rides in the same patch).
    const canSaveProfile = !!firstName.trim()
        && profileDirty && !savingProfile

    const resetProfile = () => {
        setFirstName(user?.firstName ?? '')
        setLastName(user?.lastName ?? '')
        setDisplayName('')
    }

    const handleSaveProfile = async () => {
        if (!canSaveProfile) return
        setSavingProfile(true)
        try {
            // Only send what we are allowed to change. Posting an
            // IdP-owned field earns a 409, and the user never asked to.
            const patch: Record<string, string> = { displayName: displayName.trim() }
            if (!owns('first_name')) patch.firstName = firstName.trim()
            if (!owns('last_name')) patch.lastName = lastName.trim()

            const updated = await accountService.updateProfile(patch)
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
            showToast('success', 'Password changed. Sign in again.')
            // Same teardown as the sign-out-everywhere button above, and
            // for the same reason: changing your password revokes every
            // session, this one included, so a tab that keeps believing
            // it is signed in lands on "You're already signed in as …"
            // instead of the login form the toast just promised.
            // ``PasswordChangeRequired`` always did this; this caller
            // did not.
            await logout()
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
        } catch (err) {
            showToast('error', (err as Error).message)
            setRevoking(false)
            return
        }
        // Sign THIS tab out too, not just the server side.
        //
        // Navigating to /login without tearing down local state left the
        // store still 'authenticated' and the cached user still in
        // localStorage, so the login page took one look and offered
        // "You're already signed in as …" — for a session that had just
        // been revoked. Reloading re-read the same cache and said it
        // again, so the user could not escape their own sign-out.
        //
        // ``logout()`` is the tested teardown: it clears the cache, resets
        // the store, and broadcasts to sibling tabs so they drop out now
        // rather than on their next request. Its POST to /auth/logout is
        // redundant after a revoke-all and harmless — it swallows its own
        // errors, so the local teardown happens either way.
        await logout()
        navigate('/login', { replace: true })
    }

    return (
        <>
            <AccountCard icon={PencilLine} title="Profile" blurb="How your name appears to everyone else.">
                <div className="space-y-5 max-w-xl">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Field
                            label="First name"
                            value={firstName}
                            onChange={setFirstName}
                            lockedBy={owns('first_name') ? managingProvider : null}
                        />
                        <Field
                            label="Last name"
                            value={lastName}
                            onChange={setLastName}
                            lockedBy={owns('last_name') ? managingProvider : null}
                        />
                    </div>

                    <Field
                        label="Display name"
                        value={displayName}
                        onChange={setDisplayName}
                        placeholder={derivedName}
                        help={
                            displayName.trim()
                                ? 'Shown instead of your first and last name.'
                                : `Leave blank to use “${derivedName || 'your name'}”.`
                        }
                    />

                    {managedFields.length > 0 && (
                        <p className="text-[11px] text-ink-muted flex items-start gap-1.5">
                            <Lock className="w-3 h-3 mt-0.5 shrink-0" />
                            <span>
                                {managingProvider} re-applies the locked fields every time
                                you sign in, so a change made here would not last. Your
                                display name is yours and is never overwritten.
                            </span>
                        </p>
                    )}
                </div>
            </AccountCard>

            <AccountCard
                icon={KeyRound}
                title="Password"
                blurb={
                    passwordSet === false
                        ? 'This account signs in through an identity provider.'
                        : 'Changing it signs you out everywhere, including here.'
                }
            >
                {passwordSet === false ? (
                    <div className="text-sm text-ink-secondary space-y-2 max-w-xl">
                        <p>
                            You sign in with{' '}
                            {identities[0]?.provider.displayName ?? 'your identity provider'}.
                            There is no password on this account to change.
                        </p>
                        <p className="text-ink-muted text-[13px]">
                            If you need one — to sign in when the provider is
                            unavailable, or is being retired — ask here. An
                            administrator approves it and sends you a link.
                        </p>
                        {passwordRequested ? (
                            <p
                                role="status"
                                className="text-[13px] text-emerald-600 dark:text-emerald-400"
                            >
                                Requested. An administrator will see it and get
                                a reset link to you.
                            </p>
                        ) : (
                            <button
                                type="button"
                                onClick={() => void handleRequestPassword()}
                                disabled={requestingPassword}
                                className="px-3 py-1.5 rounded-lg border border-glass-border bg-canvas text-xs font-medium text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors disabled:opacity-50"
                            >
                                Request a password
                            </button>
                        )}
                    </div>
                ) : !passwordOpen ? (
                    <button
                        type="button"
                        onClick={() => setPasswordOpen(true)}
                        className="flex items-center justify-between w-full max-w-xl px-4 py-3 rounded-xl border border-glass-border bg-canvas hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors text-left group"
                    >
                        <span className="text-sm text-ink">Change my password</span>
                        <ChevronRight className="w-4 h-4 text-ink-muted group-hover:translate-x-0.5 transition-transform" />
                    </button>
                ) : (
                    <form onSubmit={handleChangePassword} className="space-y-5 max-w-xl">
                        <Field
                            label="Current password"
                            type="password"
                            value={currentPassword}
                            onChange={setCurrentPassword}
                        />
                        <div>
                            <Field
                                label="New password"
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
                                                    i <= score ? STRENGTH_COLORS[score] : 'bg-black/10 dark:bg-white/10',
                                                )}
                                            />
                                        ))}
                                    </div>
                                    <div className="flex items-start justify-between mt-1.5 gap-2">
                                        <p className="text-[11px] text-ink-muted">{STRENGTH_LABELS[score]}</p>
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
                            type="password"
                            value={confirmPassword}
                            onChange={setConfirmPassword}
                            help={
                                confirmPassword.length > 0 && confirmPassword !== newPassword
                                    ? 'These do not match.'
                                    : ''
                            }
                        />

                        {passwordError && (
                            <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
                                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                                <span>{passwordError}</span>
                            </div>
                        )}

                        <div className="flex items-center justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => { setPasswordOpen(false); setPasswordError(null) }}
                                className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={!canSubmitPassword}
                                className={cn(
                                    'px-4 py-2 rounded-xl font-medium text-sm text-white bg-accent-lineage',
                                    'hover:brightness-110 transition-colors shadow-sm shadow-accent-lineage/20',
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                            >
                                {savingPassword ? 'Changing…' : 'Change password'}
                            </button>
                        </div>
                    </form>
                )}
            </AccountCard>

            <AccountCard icon={Clock} title="Recent activity" blurb="Security changes on your account.">
                {activity.length === 0 ? (
                    <EmptyState icon={Clock}>
                        Nothing recorded yet. This history starts from the point your
                        deployment was upgraded.
                    </EmptyState>
                ) : (
                    <ul>
                        {activity.map((row) => (
                            <li
                                key={row.id}
                                className="flex items-center justify-between gap-3 py-2.5 border-b border-glass-border last:border-0"
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
            </AccountCard>

            {/* Recoverable — you sign back in — so this is a plain card
                with a red button, not a red card. Reserve the alarming
                treatment for things that cannot be undone. */}
            <AccountCard
                icon={ShieldCheck}
                title="Signed-in devices"
                blurb="If you think somebody else has your session, end them all."
            >
                <div className="flex items-center justify-between gap-4 flex-wrap">
                    <p className="text-[13px] text-ink-muted">
                        Signs out every browser and device — this one included.
                    </p>
                    <button
                        type="button"
                        onClick={handleRevokeAll}
                        disabled={revoking}
                        className={cn(
                            'shrink-0 px-4 py-2 rounded-xl font-medium text-sm flex items-center gap-2',
                            'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20',
                            'hover:bg-red-500/20 transition-colors disabled:opacity-50',
                        )}
                    >
                        <LogOut className="w-4 h-4" />
                        {revoking ? 'Signing out…' : 'Sign out everywhere'}
                    </button>
                </div>
            </AccountCard>

            {/* Appears only when something changed. A permanently visible
                Save invites "did I change anything?"; this answers it
                before it is asked. */}
            {profileDirty && (
                <div className="fixed inset-x-0 bottom-0 z-20 pointer-events-none animate-in slide-in-from-bottom-2 duration-200">
                    <div className={cn(pageGeometry(), 'pb-6')}>
                        <div className="mx-auto w-full max-w-[1100px] flex justify-end">
                            <div className="pointer-events-auto flex items-center gap-4 rounded-2xl border border-glass-border bg-canvas-overlay/95 backdrop-blur px-5 py-3 shadow-lg">
                                <span className="text-[13px] text-ink-secondary">Unsaved changes</span>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={resetProfile}
                                        className="px-3 py-1.5 rounded-lg text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-1.5"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                        Discard
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleSaveProfile}
                                        disabled={!canSaveProfile}
                                        className={cn(
                                            'px-4 py-1.5 rounded-lg font-medium text-sm text-white bg-accent-lineage',
                                            'hover:brightness-110 transition-colors shadow-sm shadow-accent-lineage/20',
                                            'disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5',
                                        )}
                                    >
                                        <Check className="w-3.5 h-3.5" />
                                        {savingProfile ? 'Saving…' : 'Save changes'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}

/**
 * A form field that can be owned by somebody else.
 *
 * ``lockedBy`` renders the input read-only and attributes it, rather
 * than leaving an editable-looking box whose value reverts at the next
 * sign-in. Attribution matters as much as the lock: "you cannot change
 * this" invites a support ticket, "Okta manages this" tells the person
 * where to go.
 */
function Field({
    label, value, onChange, placeholder, type = 'text', help, lockedBy,
}: {
    label: string
    value: string
    onChange: (v: string) => void
    placeholder?: string
    type?: string
    help?: string
    lockedBy?: string | null
}) {
    const locked = !!lockedBy
    return (
        <label className="block">
            <span className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-ink-secondary">{label}</span>
                {locked && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-muted">
                        <Lock className="w-2.5 h-2.5" />
                        {lockedBy}
                    </span>
                )}
            </span>
            <input
                type={type}
                value={value}
                placeholder={placeholder}
                disabled={locked}
                readOnly={locked}
                onChange={(e) => onChange(e.target.value)}
                className={cn(
                    'mt-1.5 w-full px-3 py-2 rounded-lg border border-glass-border text-sm',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-shadow',
                    locked
                        ? 'bg-black/[0.03] dark:bg-white/[0.03] text-ink-muted cursor-not-allowed'
                        : 'bg-canvas text-ink placeholder:text-ink-muted/60',
                )}
            />
            {help && <span className="block text-[11px] text-ink-muted mt-1">{help}</span>}
        </label>
    )
}
