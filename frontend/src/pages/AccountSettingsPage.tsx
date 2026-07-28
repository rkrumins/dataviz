/**
 * AccountSettingsPage — manage your own account.
 *
 * Everything account-shaped in this product used to be something an
 * administrator did to somebody else: Admin → Users could rename you,
 * reset your password, suspend you. There was no screen where you could
 * do any of it yourself.
 *
 * Four things drive the layout:
 *
 * **It is shaped like every other page in the app.** Full-width
 * PageContainer and the house hero — gradient icon tile, h1, blurb —
 * the same as My access next door. It briefly used the `narrow` width
 * that PageContainer documents for settings forms; on a wide monitor
 * that stranded a 768px column in the middle of nothing, which is the
 * exact complaint PageContainer's own comment makes about capping too
 * hard. Width is spent on a second column, not on wider inputs.
 *
 * **Who you are sits in the rail.** Avatar, name, role and the methods
 * that can sign you in stay visible while you scroll the sections —
 * they are context for the editing, not a step in it.
 *
 * **Provenance is visible.** When an IdP owns a field it is shown locked
 * and attributed, because the alternative is an editable-looking input
 * whose value silently reverts at the next sign-in. The lock is per
 * field, not per account: a directory that releases a first name but no
 * surname owns only the first.
 *
 * **Destructive things are separated and quiet.** The password form is
 * collapsed until asked for (it dominated the page open), and signing out
 * everywhere lives in its own zone rather than beside a Save button.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
    AlertCircle, Check, ChevronRight, Clock, Fingerprint, KeyRound, Link2,
    Lock, LogOut, Mail, PencilLine, ShieldCheck, UserCog, X,
} from 'lucide-react'

import { PageContainer, pageGeometry } from '@/components/layout/PageContainer'
import { AvatarPickerDialog, useAvatarContent } from '@/components/layout/AvatarPickerDialog'
import { useToast } from '@/components/ui/toast'
import {
    STRENGTH_COLORS, STRENGTH_LABELS, MIN_STRENGTH_SCORE, usePasswordStrength,
} from '@/lib/passwordStrength'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { cn } from '@/lib/utils'
import { accountService, type AccountActivityItem } from '@/services/accountService'
import { authService, type UserIdentity } from '@/services/authService'
import { useAuthStore, SYSTEM_ROLE_LABELS, type SystemRole } from '@/store/auth'
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
    const avatar = useAvatarContent()

    const [firstName, setFirstName] = useState(user?.firstName ?? '')
    const [lastName, setLastName] = useState(user?.lastName ?? '')
    const [displayName, setDisplayName] = useState('')
    const [savingProfile, setSavingProfile] = useState(false)
    const [avatarOpen, setAvatarOpen] = useState(false)

    const [managedFields, setManagedFields] = useState<string[]>([])
    const [managedBy, setManagedBy] = useState<string | null>(null)
    const [identities, setIdentities] = useState<UserIdentity[]>([])
    const [passwordSet, setPasswordSet] = useState<boolean | null>(null)

    const [passwordOpen, setPasswordOpen] = useState(false)
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [passwordError, setPasswordError] = useState<string | null>(null)
    const [savingPassword, setSavingPassword] = useState(false)
    const { score, feedback } = usePasswordStrength(newPassword)

    const [revoking, setRevoking] = useState(false)
    const [activity, setActivity] = useState<AccountActivityItem[]>([])

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
                const res = await authService.listMyIdentities()
                if (cancelled) return
                setPasswordSet(res.passwordSet)
                setIdentities(res.identities)
            } catch {
                if (!cancelled) setPasswordSet(true)
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
    const initials = `${(firstName[0] ?? '').toUpperCase()}${(lastName[0] ?? '').toUpperCase()}`

    const profileDirty = useMemo(() => (
        firstName.trim() !== (user?.firstName ?? '')
        || lastName.trim() !== (user?.lastName ?? '')
        || displayName.trim() !== ''
    ), [firstName, lastName, displayName, user])

    const canSaveProfile = !!firstName.trim() && !!lastName.trim()
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
        const chosen = usePreferencesStore.getState().avatarId
        if (chosen === (user?.avatarId ?? null)) return
        try {
            await accountService.updateProfile({ avatarId: chosen ?? '' })
            applyProfile({ avatarId: chosen })
        } catch (err) {
            showToast('error', `Avatar saved on this device only: ${(err as Error).message}`)
        }
    }

    const roleLabel = user?.role
        ? (SYSTEM_ROLE_LABELS[user.role as SystemRole] ?? user.role)
        : null

    return (
        <div className="absolute inset-0 overflow-y-auto bg-canvas">
            <PageContainer className="py-6 pb-28 space-y-6">

                {/* Hero — same shape as My access next door. */}
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md shrink-0">
                        <UserCog className="w-6 h-6 text-white" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-bold text-ink">Account settings</h1>
                        <p className="text-sm text-ink-muted">
                            Your name, your password, and the devices you are signed in on.
                        </p>
                    </div>
                </div>

                {/* Sections left, identity rail right. The rail is what
                    earns the full page width — the alternative is one
                    column of inputs stretched across a monitor. */}
                <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
                <div className="space-y-6 min-w-0">

                {/* ── Profile ─────────────────────────────────────── */}
                <Section
                    icon={PencilLine}
                    title="Profile"
                    blurb={
                        managedFields.length > 0
                            ? `Some of these come from ${managingProvider} and are kept in step with it.`
                            : 'How your name appears to everyone else.'
                    }
                >
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

                    {/* Paired fields get half the column each; a lone one
                        would otherwise run the full width of a monitor,
                        which is unreadable and looks like a mistake. */}
                    <div className="sm:max-w-[calc(50%-0.5rem)]">
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
                    </div>

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
                </Section>

                {/* ── Password ────────────────────────────────────── */}
                <Section
                    icon={KeyRound}
                    title="Password"
                    blurb={
                        passwordSet === false
                            ? 'This account signs in through an identity provider.'
                            : 'Changing it signs you out everywhere, including here.'
                    }
                >
                    {passwordSet === false ? (
                        <div className="text-sm text-ink-secondary space-y-2">
                            <p>
                                You sign in with{' '}
                                {identities[0]?.provider.displayName ?? 'your identity provider'}.
                                There is no password on this account to change.
                            </p>
                            <p className="text-ink-muted text-[13px]">
                                If you need one — to sign in when the provider is
                                unavailable, say — an administrator can set it for you.
                            </p>
                        </div>
                    ) : !passwordOpen ? (
                        <button
                            type="button"
                            onClick={() => setPasswordOpen(true)}
                            className="flex items-center justify-between w-full px-4 py-3 rounded-xl border border-glass-border bg-canvas hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors text-left group"
                        >
                            <span className="text-sm text-ink">Change my password</span>
                            <ChevronRight className="w-4 h-4 text-ink-muted group-hover:translate-x-0.5 transition-transform" />
                        </button>
                    ) : (
                        <form onSubmit={handleChangePassword} className="space-y-5">
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
                                <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
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
                </Section>

                {/* ── Activity ────────────────────────────────────── */}
                <Section icon={Clock} title="Recent activity" blurb="Security changes on your account.">
                    {activity.length === 0 ? (
                        <p className="text-[13px] text-ink-muted">
                            Nothing recorded yet. This history starts from the point your
                            deployment was upgraded, so it will not show anything older.
                        </p>
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
                </Section>

                {/* ── Danger zone ─────────────────────────────────────
                    Separated because it is not a setting — it ends every
                    session you have, and it does not belong next to Save. */}
                <section className="rounded-2xl border border-red-500/20 bg-red-500/[0.03] p-6">
                    <div className="flex items-start gap-3 mb-4">
                        <div className="w-9 h-9 rounded-xl bg-red-500/10 flex items-center justify-center shrink-0">
                            <ShieldCheck className="w-4.5 h-4.5 text-red-500" />
                        </div>
                        <div>
                            <h2 className="text-sm font-bold text-ink">Signed-in devices</h2>
                            <p className="text-xs text-ink-muted mt-0.5">
                                If you think somebody else has your session, end them all.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center justify-between gap-4">
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
                </section>

                </div>

                {/* ── Identity rail ───────────────────────────────────
                    Sticky, because who you are is context for the
                    editing rather than a step in it — and because it is
                    what makes the second column worth having. */}
                <aside className="space-y-4 xl:sticky xl:top-6">
                    <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-5">
                        <div className="flex flex-col items-center text-center">
                            <button
                                type="button"
                                onClick={() => setAvatarOpen(true)}
                                title="Change avatar"
                                className="relative group rounded-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                            >
                                {avatar ? (
                                    <div className={cn('w-20 h-20 rounded-full flex items-center justify-center', avatar.bg)}>
                                        {avatar.content('w-10 h-10 text-ink')}
                                    </div>
                                ) : (
                                    <div className="w-20 h-20 rounded-full flex items-center justify-center bg-accent-lineage/15">
                                        <span className="text-2xl font-semibold text-accent-lineage select-none">
                                            {initials || '?'}
                                        </span>
                                    </div>
                                )}
                                <span className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                    <PencilLine className="w-5 h-5 text-white" />
                                </span>
                            </button>

                            <p className="mt-3 text-base font-semibold text-ink truncate max-w-full">
                                {displayName.trim() || derivedName || 'Your account'}
                            </p>
                            <div className="flex items-center gap-1.5 mt-1 text-xs text-ink-muted max-w-full">
                                <Mail className="w-3 h-3 shrink-0" />
                                <span className="truncate">{user?.email}</span>
                            </div>
                            {roleLabel && (
                                <span className="mt-3 px-2 py-1 rounded-lg text-[11px] font-semibold bg-accent-lineage/10 text-accent-lineage border border-accent-lineage/20">
                                    {roleLabel}
                                </span>
                            )}
                        </div>

                        <div className="mt-5 pt-4 border-t border-glass-border">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-2">
                                Ways you sign in
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {passwordSet && <Chip icon={KeyRound} label="Password" />}
                                {identities.map((i) => (
                                    <Chip key={i.id} icon={Fingerprint} label={i.provider.displayName} />
                                ))}
                                {passwordSet === false && identities.length === 0 && (
                                    <Chip icon={AlertCircle} label="No sign-in method" tone="warn" />
                                )}
                            </div>
                        </div>
                    </div>

                    <nav className="rounded-2xl border border-glass-border bg-canvas-elevated divide-y divide-glass-border overflow-hidden">
                        <RailLink to="/me/identities" icon={Link2} label="Connected identities" />
                        <RailLink to="/my/access" icon={ShieldCheck} label="What I can access" />
                    </nav>
                </aside>
                </div>
            </PageContainer>

            {/* ── Sticky save bar ────────────────────────────────────
                Appears only when something changed. A permanently
                visible Save invites the question "did I change
                anything?"; this answers it before it is asked. */}
            {profileDirty && (
                <div className="sticky bottom-0 z-20 animate-in slide-in-from-bottom-2 duration-200">
                    {/* Same cap and gutters as the content it belongs to,
                        via the shared helper — a sticky bar cannot be a
                        PageContainer, but it must line up with one. */}
                    <div className={cn(pageGeometry(), 'pb-6')}>
                        <div className="flex items-center justify-between gap-4 rounded-2xl border border-glass-border bg-canvas-overlay/95 backdrop-blur px-5 py-3 shadow-lg">
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
            )}

            <AvatarPickerDialog
                isOpen={avatarOpen}
                onClose={handleAvatarDialogClosed}
                initials={initials || '?'}
            />
        </div>
    )
}

// ── Building blocks ─────────────────────────────────────────────────

function RailLink({
    to, icon: Icon, label,
}: {
    to: string
    icon: typeof Link2
    label: string
}) {
    return (
        <Link
            to={to}
            className="flex items-center justify-between gap-2 px-4 py-3 text-[13px] text-ink-secondary hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors group"
        >
            <span className="inline-flex items-center gap-2">
                <Icon className="w-3.5 h-3.5" />
                {label}
            </span>
            <ChevronRight className="w-3.5 h-3.5 text-ink-muted group-hover:translate-x-0.5 transition-transform" />
        </Link>
    )
}

function Chip({
    icon: Icon, label, tone = 'neutral',
}: {
    icon: typeof KeyRound
    label: string
    tone?: 'neutral' | 'warn'
}) {
    return (
        <span className={cn(
            'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium border',
            tone === 'warn'
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
                : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary border-glass-border',
        )}>
            <Icon className="w-3 h-3" />
            {label}
        </span>
    )
}

function Section({
    icon: Icon, title, blurb, children,
}: {
    icon: typeof KeyRound
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
