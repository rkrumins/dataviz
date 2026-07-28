/**
 * AccountShell — the chrome every "my account" page renders into.
 *
 * The account pages were built at different times and looked it: one
 * reading-width column of inputs stranded in the middle of a wide
 * monitor, another with its own header, neither aware the other existed.
 * They are one area of the product, so they get one shell.
 *
 * The shape is the one every settings surface worth copying converges on
 * — a fixed rail carrying identity and navigation, beside a content
 * column capped at a width where a text input is still a sensible size.
 * Full-bleed is wrong here for the same reason `narrow` was: a settings
 * form does not improve at 1700px, it just gets harder to scan. The cap
 * is generous enough that the page reads as deliberate rather than
 * marooned, and the width that is left over carries the rail rather than
 * stretching a name field across a monitor.
 *
 * The shell owns the identities fetch because both pages need it — the
 * profile page to decide whether to show a password form, this rail to
 * list the ways you can sign in. Fetching it here means one request
 * instead of two and one source of truth for "can this account still
 * sign in at all".
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
    AlertCircle, ChevronRight, Fingerprint, KeyRound, Link2, Mail,
    PencilLine, ShieldCheck, UserCog,
} from 'lucide-react'

import { PageContainer } from '@/components/layout/PageContainer'
import { AvatarPickerDialog, useAvatarContent } from '@/components/layout/AvatarPickerDialog'
import { cn } from '@/lib/utils'
import { accountService } from '@/services/accountService'
import { authService, type UserIdentity } from '@/services/authService'
import { useAuthStore, SYSTEM_ROLE_LABELS, type SystemRole } from '@/store/auth'
import { usePreferencesStore } from '@/store/preferences'

interface AccountIdentityState {
    /** Null until the first fetch resolves — "unknown", not "no". */
    passwordSet: boolean | null
    identities: UserIdentity[]
    refresh: () => Promise<void>
}

const AccountIdentityContext = createContext<AccountIdentityState>({
    passwordSet: null,
    identities: [],
    refresh: async () => {},
})

/** The account's sign-in methods, fetched once by the shell. */
export function useAccountIdentity(): AccountIdentityState {
    return useContext(AccountIdentityContext)
}

const NAV = [
    { to: '/me/account', label: 'Profile & password', icon: UserCog, end: true },
    { to: '/me/identities', label: 'Connected identities', icon: Link2, end: true },
    { to: '/my/access', label: 'My access', icon: ShieldCheck, end: true },
]

export function AccountShell({
    title, blurb, actions, children,
}: {
    title: string
    blurb: string
    /** Page-level action for the hero row, e.g. a Refresh button. */
    actions?: React.ReactNode
    children: React.ReactNode
}) {
    const user = useAuthStore((s) => s.user)
    const applyProfile = useAuthStore((s) => s.applyProfile)
    const avatar = useAvatarContent()
    const [avatarOpen, setAvatarOpen] = useState(false)

    const [passwordSet, setPasswordSet] = useState<boolean | null>(null)
    const [identities, setIdentities] = useState<UserIdentity[]>([])

    const refresh = useCallback(async () => {
        try {
            const res = await authService.listMyIdentities()
            setPasswordSet(res.passwordSet)
            setIdentities(res.identities)
        } catch {
            // A failed probe must not decide that an account has no
            // password — that would hide the change-password form from
            // the people most likely to need it.
            setPasswordSet(null)
        }
    }, [])

    useEffect(() => { void refresh() }, [refresh])

    const initials = user
        ? `${(user.firstName?.[0] ?? '').toUpperCase()}${(user.lastName?.[0] ?? '').toUpperCase()}`
        : '?'
    const roleLabel = user?.role
        ? (SYSTEM_ROLE_LABELS[user.role as SystemRole] ?? user.role)
        : null

    const handleAvatarClosed = async () => {
        setAvatarOpen(false)
        const chosen = usePreferencesStore.getState().avatarId
        if (chosen === (user?.avatarId ?? null)) return
        try {
            await accountService.updateProfile({ avatarId: chosen ?? '' })
            applyProfile({ avatarId: chosen })
        } catch {
            // Already applied locally, so it looks right on this screen.
            // It just will not follow them to another browser.
        }
    }

    return (
        <AccountIdentityContext.Provider value={{ passwordSet, identities, refresh }}>
            <div className="absolute inset-0 overflow-y-auto bg-canvas">
                <PageContainer className="py-6 pb-28">
                    <div className="mx-auto w-full max-w-[1100px]">

                        <div className="flex items-center justify-between gap-4 mb-6">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md shadow-indigo-500/20 shrink-0">
                                    <UserCog className="w-6 h-6 text-white" />
                                </div>
                                <div className="min-w-0">
                                    <h1 className="text-2xl font-bold text-ink">{title}</h1>
                                    <p className="text-sm text-ink-muted">{blurb}</p>
                                </div>
                            </div>
                            {actions && <div className="shrink-0">{actions}</div>}
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-[248px_minmax(0,1fr)] gap-6 items-start">

                            <aside className="space-y-3 lg:sticky lg:top-6">
                                <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-5">
                                    <div className="flex flex-col items-center text-center">
                                        <button
                                            type="button"
                                            onClick={() => setAvatarOpen(true)}
                                            title="Change avatar"
                                            className="relative group rounded-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                                        >
                                            {avatar ? (
                                                <div className={cn('w-16 h-16 rounded-full flex items-center justify-center ring-4 ring-black/[0.03] dark:ring-white/[0.04]', avatar.bg)}>
                                                    {avatar.content('w-8 h-8 text-ink')}
                                                </div>
                                            ) : (
                                                <div className="w-16 h-16 rounded-full flex items-center justify-center bg-accent-lineage/15 ring-4 ring-black/[0.03] dark:ring-white/[0.04]">
                                                    <span className="text-xl font-semibold text-accent-lineage select-none">
                                                        {initials}
                                                    </span>
                                                </div>
                                            )}
                                            <span className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                                <PencilLine className="w-4 h-4 text-white" />
                                            </span>
                                        </button>

                                        <p className="mt-3 text-sm font-semibold text-ink truncate max-w-full">
                                            {user?.displayName
                                                || [user?.firstName, user?.lastName].filter(Boolean).join(' ')
                                                || 'Your account'}
                                        </p>
                                        <span className="flex items-center gap-1 mt-1 text-[11px] text-ink-muted max-w-full">
                                            <Mail className="w-3 h-3 shrink-0" />
                                            <span className="truncate">{user?.email}</span>
                                        </span>
                                        {roleLabel && (
                                            <span className="mt-2.5 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-accent-lineage/10 text-accent-lineage border border-accent-lineage/20">
                                                {roleLabel}
                                            </span>
                                        )}
                                    </div>

                                    <div className="mt-4 pt-4 border-t border-glass-border">
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

                                <nav className="rounded-2xl border border-glass-border bg-canvas-elevated p-1.5">
                                    {NAV.map(({ to, label, icon: Icon, end }) => (
                                        <NavLink
                                            key={to}
                                            to={to}
                                            end={end}
                                            className={({ isActive }) => cn(
                                                'flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-[13px] transition-colors',
                                                isActive
                                                    ? 'bg-accent-lineage/10 text-accent-lineage font-semibold'
                                                    : 'text-ink-secondary hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                            )}
                                        >
                                            {({ isActive }) => (
                                                <>
                                                    <span className="inline-flex items-center gap-2.5 min-w-0">
                                                        <Icon className="w-4 h-4 shrink-0" />
                                                        <span className="truncate">{label}</span>
                                                    </span>
                                                    {!isActive && (
                                                        <ChevronRight className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                                                    )}
                                                </>
                                            )}
                                        </NavLink>
                                    ))}
                                </nav>
                            </aside>

                            <main className="min-w-0 space-y-5">{children}</main>
                        </div>
                    </div>
                </PageContainer>

                <AvatarPickerDialog
                    isOpen={avatarOpen}
                    onClose={handleAvatarClosed}
                    initials={initials}
                />
            </div>
        </AccountIdentityContext.Provider>
    )
}

// ── Shared building blocks ──────────────────────────────────────────

export function Chip({
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

/** A titled card. One rhythm for every block on every account page. */
export function AccountCard({
    icon: Icon, title, blurb, tone = 'neutral', children,
}: {
    icon: typeof KeyRound
    title: string
    blurb?: string
    tone?: 'neutral' | 'danger'
    children: React.ReactNode
}) {
    return (
        <section className={cn(
            'rounded-2xl border p-5 sm:p-6',
            tone === 'danger'
                ? 'border-red-500/20 bg-red-500/[0.02]'
                : 'border-glass-border bg-canvas-elevated',
        )}>
            <div className="flex items-start gap-3 mb-5">
                <div className={cn(
                    'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
                    tone === 'danger' ? 'bg-red-500/10' : 'bg-indigo-500/10',
                )}>
                    <Icon className={cn('w-4.5 h-4.5', tone === 'danger' ? 'text-red-500' : 'text-indigo-500')} />
                </div>
                <div className="min-w-0">
                    <h2 className="text-sm font-bold text-ink">{title}</h2>
                    {blurb && <p className="text-xs text-ink-muted mt-0.5">{blurb}</p>}
                </div>
            </div>
            {children}
        </section>
    )
}

/** Centred, quiet, one line. An empty state is not a place for a paragraph. */
export function EmptyState({ icon: Icon, children }: { icon: typeof KeyRound; children: React.ReactNode }) {
    return (
        <div className="flex flex-col items-center text-center py-8 px-4">
            <div className="w-10 h-10 rounded-full bg-black/[0.04] dark:bg-white/[0.05] flex items-center justify-center mb-3">
                <Icon className="w-4.5 h-4.5 text-ink-muted" />
            </div>
            <p className="text-[13px] text-ink-muted max-w-sm">{children}</p>
        </div>
    )
}
