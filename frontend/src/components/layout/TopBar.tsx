import { useEffect, useState } from 'react'
import { Search, Settings, User, Moon, Sun, Monitor, LogOut, Pencil, Shield, Sparkles, Check, HelpCircle, UserCog, Link2 } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PersonaToggle } from '@/components/persona/PersonaToggle'
import { BrandLogo } from '@/components/brand/BrandLogo'
import { BrandName } from '@/components/brand/BrandName'
import { BookmarksPopover } from '@/components/layout/BookmarksPopover'
import { NotificationBell as InviteActivityBell } from '@/components/layout/NotificationBell'
import { NotificationBell } from '@/components/notifications/NotificationBell'
import { AvatarPickerDialog, useAvatarContent } from '@/components/layout/AvatarPickerDialog'
import { usePreferencesStore } from '@/store/preferences'
import { usePersonaStore } from '@/store/persona'
import {
  useAuthStore,
  usePermission,
  usePermissionClaims,
  effectiveRoleFor,
  SYSTEM_ROLE_LABELS,
  type SystemRole,
} from '@/store/auth'
import { useSchemaStore } from '@/store/schema'
import { useHelpPanelStore } from '@/store/helpPanel'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { cn } from '@/lib/utils'

interface TopBarProps {
  onOpenCommandPalette: () => void
}

/** Dynamic search placeholder based on route context */
function useSearchPlaceholder(): string {
  const location = useLocation()
  const activeView = useSchemaStore((s) => s.getActiveView())

  if (location.pathname.startsWith('/views/') && activeView) {
    return `Search nodes in ${activeView.name}...`
  }
  if (location.pathname.startsWith('/explorer')) {
    return 'Filter views by name, tag, or workspace...'
  }
  return 'Search workspaces, views, or commands...'
}

export function TopBar({ onOpenCommandPalette }: TopBarProps) {
  // Selector subscriptions so this always-mounted bar doesn't re-render on
  // unrelated preference/auth writes.
  const theme = usePreferencesStore((s) => s.theme)
  const setTheme = usePreferencesStore((s) => s.setTheme)
  const reducedMotion = usePreferencesStore((s) => s.reducedMotion)
  const setReducedMotion = usePreferencesStore((s) => s.setReducedMotion)
  const persona = usePersonaStore((s) => s.mode)
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const isSystemAdmin = usePermission('system:admin')
  const isOrgAdmin = usePermission('system:org-admin')
  const claims = usePermissionClaims()
  const location = useLocation()
  const searchPlaceholder = useSearchPlaceholder()
  const navigate = useNavigate()
  const avatar = useAvatarContent()
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false)
  const avatarId = usePreferencesStore((s) => s.avatarId)
  const setAvatarId = usePreferencesStore((s) => s.setAvatarId)
  const applyProfile = useAuthStore((s) => s.applyProfile)

  // The avatar preference is browser-local, so on a machine you have
  // not used before it starts empty and you appear as initials. Seed it
  // from the account once the session lands.
  useEffect(() => {
    if (user?.avatarId && user.avatarId !== avatarId) setAvatarId(user.avatarId)
    // Deliberately keyed on the server value alone: reacting to local
    // changes too would re-apply the stored avatar the moment somebody
    // picked a different one, making the picker look broken.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.avatarId])

  /** Persist whatever the picker left in the preference store. */
  const handleAvatarPickerClosed = async () => {
    setAvatarPickerOpen(false)
    const chosen = usePreferencesStore.getState().avatarId
    if (chosen === (user?.avatarId ?? null)) return
    try {
      const { accountService } = await import('@/services/accountService')
      await accountService.updateProfile({ avatarId: chosen ?? '' })
      applyProfile({ avatarId: chosen })
    } catch {
      // Already applied locally, so it looks right here. It just will
      // not follow them to another browser.
    }
  }

  // Phase 5: derive a workspace-aware role badge. When the route is
  // ``/workspaces/:wsId/...`` (or the admin equivalent), look up the
  // user's effective tier inside that workspace; otherwise show the
  // global tier. A user who's admin in finance and viewer in marketing
  // sees the badge flip as they navigate between the two — preventing
  // the "why am I still seeing 'admin' but getting 403s" confusion.
  const activeWorkspaceId = (() => {
    const m = location.pathname.match(
      /^\/(?:admin\/)?workspaces\/([^/]+)/,
    )
    return m?.[1] ?? null
  })()
  const effectiveRole: SystemRole | null = effectiveRoleFor(
    claims, activeWorkspaceId,
  )
  const roleBadgeLabel = effectiveRole
    ? SYSTEM_ROLE_LABELS[effectiveRole]
    : (user?.role ?? 'Member')
  const roleBadgeIsAdmin = effectiveRole === 'super_admin'
    || effectiveRole === 'org_admin'
    || effectiveRole === 'workspace_admin'

  // The admin nav cog shows for super_admin OR org_admin — both tiers
  // see at least part of /admin (org_admin gets workspaces/SSO but not
  // users/groups; the section guards inside /admin enforce that).
  const showAdminCog = isSystemAdmin || isOrgAdmin

  const initials = user
    ? `${(user.firstName?.[0] ?? '').toUpperCase()}${(user.lastName?.[0] ?? '').toUpperCase()}`
    : '?'

  /** Renders the user avatar — chosen illustration or initials fallback */
  const renderAvatar = (size: 'sm' | 'md') => {
    const dims = size === 'sm' ? 'w-8 h-8' : 'w-9 h-9'
    const iconDims = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'
    const textSize = size === 'sm' ? 'text-xs' : 'text-sm'

    if (avatar) {
      return (
        <div className={cn(dims, 'rounded-full flex items-center justify-center', avatar.bg)}>
          {avatar.content(cn(iconDims, 'text-ink'))}
        </div>
      )
    }
    if (user) {
      return (
        <div className={cn(dims, 'rounded-full flex items-center justify-center bg-accent-lineage/15')}>
          <span className={cn(textSize, 'font-semibold text-accent-lineage select-none leading-none')}>
            {initials}
          </span>
        </div>
      )
    }
    return (
      <div className={cn(dims, 'rounded-full flex items-center justify-center bg-accent-lineage/15')}>
        <User className={cn(iconDims, 'text-accent-lineage')} />
      </div>
    )
  }

  return (
    <>
      <header className="h-14 border-b border-glass-border bg-canvas-elevated flex items-center justify-between px-4 z-50">
        {/* Left: Logo + Breadcrumb */}
        <div className="flex items-center gap-3 min-w-0">
          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0">
            <BrandLogo className="w-8 h-8" glyphClassName="w-5 h-5" />
            <div>
              <h1 className="font-display font-semibold text-lg leading-none">
                <BrandName short />
              </h1>
              <p className="text-2xs text-ink-muted">
                {persona === 'business' ? 'Business View' : 'Technical View'}
              </p>
            </div>
          </div>

        </div>

        {/* Center: Search Bar — visually paired with the Dashboard hero search */}
        <div className="flex-1 max-w-xl mx-8 relative group">
          {/* Soft gradient halo on hover, mirrors the Hero's focus glow at smaller scale */}
          <div className={cn(
            'absolute -inset-0.5 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300',
            'bg-gradient-to-r from-accent-business/30 via-accent-explore/20 to-accent-lineage/30'
          )} />
          <button
            data-tour="search"
            onClick={onOpenCommandPalette}
            className={cn(
              "relative w-full flex items-center gap-3 px-4 py-2 rounded-xl",
              "bg-canvas border border-glass-border",
              "text-ink-muted hover:border-accent-business/40 hover:bg-canvas-elevated",
              "transition-all duration-200"
            )}
          >
            <Search className="w-4 h-4 group-hover:text-accent-business transition-colors duration-200" />
            <span className="flex-1 text-left text-sm group-hover:text-ink-secondary transition-colors">
              {searchPlaceholder}
            </span>
            <div className="flex items-center gap-1">
              <kbd className="kbd">⌘</kbd>
              <kbd className="kbd">K</kbd>
            </div>
          </button>
        </div>

        {/* Right: Actions — 3 groups separated by dividers */}
        <div className="flex items-center gap-2">
          {/* Group 1: Mode */}
          <span data-tour="persona" className="inline-flex">
            <PersonaToggle />
          </span>

          <div className="w-px h-6 bg-glass-border mx-1" />

          {/* Group 2: Content shortcuts */}
          <BookmarksPopover />
          <InviteActivityBell />
          <NotificationBell />

          <div className="w-px h-6 bg-glass-border mx-1" />

          {/* Group 3: System / Account */}
          <ThemeSwitcher theme={theme} onChange={setTheme} />

          <button
            data-tour="help"
            className="btn btn-ghost p-2 rounded-lg"
            onClick={() => useHelpPanelStore.getState().openHelp()}
            title="Help (?)"
            aria-label="Help"
          >
            <HelpCircle className="w-5 h-5 text-ink-secondary" />
          </button>

          {showAdminCog && (
            <button
              className="btn btn-ghost p-2 rounded-lg"
              onClick={() => navigate('/admin')}
              title="Administration"
            >
              <Settings className="w-5 h-5 text-ink-secondary" />
            </button>
          )}

          {/* User Menu */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                className={cn(
                  "rounded-full flex items-center justify-center",
                  "hover:ring-2 hover:ring-accent-lineage/30",
                  "transition-all outline-none focus:ring-2 focus:ring-accent-lineage/40"
                )}
                aria-label="User menu"
              >
                {renderAvatar('sm')}
              </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="min-w-[240px] bg-canvas-elevated border border-glass-border rounded-xl shadow-xl p-2 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
                sideOffset={8}
                align="end"
              >
                {/* Profile header */}
                <div className="flex items-center gap-3 px-3 py-2.5 border-b border-glass-border mb-1">
                  <div className="relative group">
                    {renderAvatar('md')}
                    <button
                      className={cn(
                        "absolute inset-0 rounded-full flex items-center justify-center",
                        "bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity",
                        "cursor-pointer"
                      )}
                      onClick={() => setAvatarPickerOpen(true)}
                      title="Change avatar"
                    >
                      <Pencil className="w-3.5 h-3.5 text-white" />
                    </button>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">
                      {user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Unknown User'}
                    </p>
                    <p className="text-xs text-ink-muted truncate">
                      {user?.email}
                    </p>
                    <span
                      className={cn(
                        'inline-block mt-0.5 px-1.5 py-px rounded text-[10px] font-medium',
                        roleBadgeIsAdmin
                          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          : 'bg-accent-lineage/10 text-accent-lineage',
                      )}
                      title={
                        activeWorkspaceId
                          ? `Effective role in this workspace`
                          : 'Global tier'
                      }
                    >
                      {roleBadgeLabel}
                    </span>
                  </div>
                </div>

                {/* Account settings — first, because it edits the name and
                    email printed directly above it. UserCog rather than
                    Settings: Settings is already the admin cog in this bar. */}
                <DropdownMenu.Item
                  className="flex items-center gap-2 px-3 py-2 text-sm text-ink-secondary rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer outline-none focus:bg-accent-lineage/10 focus:text-accent-lineage transition-colors"
                  onSelect={() => navigate('/me/account')}
                >
                  <UserCog className="w-4 h-4" />
                  <span>Account settings</span>
                </DropdownMenu.Item>

                {/* My access — every authenticated user can read their own permissions */}
                <DropdownMenu.Item
                  className="flex items-center gap-2 px-3 py-2 text-sm text-ink-secondary rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer outline-none focus:bg-accent-lineage/10 focus:text-accent-lineage transition-colors"
                  onSelect={() => navigate('/my/access')}
                >
                  <Shield className="w-4 h-4" />
                  <span>My access</span>
                </DropdownMenu.Item>

                {/* Linked sign-in methods. The page existed and was routed
                    from the start but was linked from nowhere — including
                    from the collision modal, which told users to come here. */}
                <DropdownMenu.Item
                  className="flex items-center gap-2 px-3 py-2 text-sm text-ink-secondary rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer outline-none focus:bg-accent-lineage/10 focus:text-accent-lineage transition-colors"
                  onSelect={() => navigate('/me/identities')}
                >
                  <Link2 className="w-4 h-4" />
                  <span>Identities</span>
                </DropdownMenu.Item>

                {/* "Change Avatar" used to sit here. The picker is still two
                    clicks away — hover the avatar just above, or open Account
                    settings — so a third entry point to one preference was
                    the row worth losing when this menu gained two. */}

                {/* Reduce motion — accessibility "calm mode". preventDefault
                    keeps the menu open so it reads as a switch. Framer honours
                    this via <MotionConfig> and CSS via the .reduce-motion class. */}
                <DropdownMenu.CheckboxItem
                  className="flex items-center gap-2 px-3 py-2 text-sm text-ink-secondary rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer outline-none focus:bg-accent-lineage/10 focus:text-accent-lineage transition-colors"
                  checked={reducedMotion}
                  onCheckedChange={setReducedMotion}
                  onSelect={(e) => e.preventDefault()}
                >
                  <Sparkles className="w-4 h-4" />
                  <span className="flex-1">Reduce motion</span>
                  <DropdownMenu.ItemIndicator>
                    <Check className="w-4 h-4" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.CheckboxItem>

                <DropdownMenu.Separator className="h-px bg-glass-border my-1" />

                <DropdownMenu.Item
                  className="flex items-center gap-2 px-3 py-2 text-sm text-ink-secondary rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer outline-none focus:bg-accent-lineage/10 focus:text-accent-lineage transition-colors"
                  onSelect={logout}
                >
                  <LogOut className="w-4 h-4" />
                  <span>Sign Out</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      {/* Avatar picker dialog */}
      <AvatarPickerDialog
        isOpen={avatarPickerOpen}
        onClose={handleAvatarPickerClosed}
        initials={initials}
      />
    </>
  )
}

interface ThemeSwitcherProps {
  theme: 'light' | 'dark' | 'system'
  onChange: (theme: 'light' | 'dark' | 'system') => void
}

function ThemeSwitcher({ theme, onChange }: ThemeSwitcherProps) {
  const icons = {
    light: Sun,
    dark: Moon,
    system: Monitor,
  }
  const Icon = icons[theme]

  const cycleTheme = () => {
    const order: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system']
    const currentIndex = order.indexOf(theme)
    const nextIndex = (currentIndex + 1) % order.length
    onChange(order[nextIndex])
  }

  return (
    <button
      onClick={cycleTheme}
      className="btn btn-ghost p-2 rounded-lg group"
      title={`Theme: ${theme}`}
    >
      <Icon className="w-5 h-5 text-ink-secondary group-hover:text-ink transition-colors" />
    </button>
  )
}
