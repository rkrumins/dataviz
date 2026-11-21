/**
 * Groups, on a workspace's People tab: the teams that get access together. Each card
 * says what the group can do here, who is in it, and whether it follows a group in the
 * identity provider. A workspace's admins make groups for it, invite people and link
 * them to the directory (a platform administrator confirms a link anyone else asks
 * for); platform-wide groups bound here are listed too, and managed on Admin → Groups.
 */
import { useState } from 'react'
import { Clock, KeyRound, Link2, Plus, Shield, UsersRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { useWorkspacesStore } from '@/store/workspaces'
import { useWorkspaceGroups } from '@/hooks/useWorkspaceGroups'
import type { GroupRole, WorkspaceGroup } from '@/services/workspaceGroupsService'
import { GROUP_ROLES, groupRoleLabel } from '@/components/workspace-requests/RequestSteps'
import { CreateGroupDialog, WorkspaceGroupDrawer } from './WorkspaceGroupDrawer'

const STARTERS: { name: string; role: GroupRole }[] = [
    { name: 'Editors', role: 'workspace_member' },
    { name: 'Viewers', role: 'workspace_viewer' },
    { name: 'Publishers', role: 'workspace_publisher' },
]

/** The workspace's name as group names carry it: from the list of workspaces, else from
 *  one of its own groups ("<workspace> · <name>"). */
function useGroupPrefix(workspaceId: string, groups: WorkspaceGroup[] = []) {
    const fromStore = useWorkspacesStore(s => s.workspaces.find(w => w.id === workspaceId)?.name)
    if (fromStore) return fromStore
    const owned = groups.find(g => g.owned && g.name.endsWith(` · ${g.shortName}`))
    return owned ? owned.name.slice(0, -` · ${owned.shortName}`.length) : 'This workspace'
}

export function WorkspaceGroupsPanel({ workspaceId, canManage, onChanged }: {
    workspaceId: string
    /** Workspace admin: makes and changes the workspace's own groups. */
    canManage: boolean
    /** Something about who can get in changed — refresh the bindings. */
    onChanged?: () => void
}) {
    const { data, isLoading, isError } = useWorkspaceGroups(workspaceId)
    const groups = data ?? []
    const prefix = useGroupPrefix(workspaceId, groups)
    const [openId, setOpenId] = useState<string | null>(null)
    const [creating, setCreating] = useState<{ name: string; role: GroupRole } | null>(null)
    const open = groups.find(g => g.id === openId) ?? null
    if (isError) return null

    return (
        <section aria-labelledby="ws-groups-title" className="rounded-2xl border border-glass-border bg-canvas-elevated">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-glass-border px-5 py-4">
                <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-sm shadow-violet-500/25">
                        <UsersRound className="h-4 w-4" aria-hidden />
                    </span>
                    <div>
                        <h3 id="ws-groups-title" className="flex items-center gap-2 text-base font-bold text-ink">
                            Groups
                            {groups.length > 0 && (
                                <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">{groups.length}</span>
                            )}
                        </h3>
                        <p className="mt-0.5 max-w-2xl text-sm leading-relaxed text-ink-secondary">
                            Teams that get access together. Give each a role, invite people, and link it to your identity provider so membership follows the directory.
                        </p>
                    </div>
                </div>
                {canManage && (
                    <button type="button" onClick={() => setCreating({ name: '', role: 'workspace_member' })}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-violet-500/30 bg-violet-500/[0.06] px-3 py-2 text-sm font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-500/10">
                        <Plus className="h-4 w-4" aria-hidden /> New group
                    </button>
                )}
            </div>

            <div className="p-5">
                {isLoading ? (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {[0, 1].map(i => <div key={i} className="h-32 animate-pulse rounded-xl bg-black/[0.04] dark:bg-white/[0.05]" />)}
                    </div>
                ) : groups.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-glass-border px-5 py-6 text-center">
                        <p className="text-sm text-ink-secondary">
                            {canManage ? 'No groups yet. Start with one of these — you can rename it, change its role and invite people.' : 'No groups have access here yet.'}
                        </p>
                        {canManage && (
                            <div className="mt-3 flex flex-wrap justify-center gap-2">
                                {STARTERS.map(s => (
                                    <button key={s.name} type="button" onClick={() => setCreating(s)}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/[0.06] px-3 py-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-500/10">
                                        <Plus className="h-3.5 w-3.5" aria-hidden /> {s.name} <span className="font-normal text-ink-muted">· {groupRoleLabel(s.role)}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {groups.map(g => <li key={g.id}><GroupCard group={g} canManage={canManage} onOpen={() => setOpenId(g.id)} /></li>)}
                    </ul>
                )}
            </div>

            {open && (
                <WorkspaceGroupDrawer workspaceId={workspaceId} group={open} canManage={canManage}
                    onClose={() => setOpenId(null)} onChanged={onChanged} />
            )}
            {creating && (
                <CreateGroupDialog workspaceId={workspaceId} prefix={prefix} initial={creating}
                    onClose={() => setCreating(null)}
                    onCreated={g => { setCreating(null); onChanged?.(); setOpenId(g.id) }} />
            )}
        </section>
    )
}

function roleText(g: Pick<WorkspaceGroup, 'role' | 'roleLabel'>) {
    if (!g.role) return null
    return GROUP_ROLES.some(r => r.value === g.role) ? groupRoleLabel(g.role as GroupRole) : g.roleLabel || g.role
}

function GroupCard({ group: g, canManage, onOpen }: { group: WorkspaceGroup; canManage: boolean; onOpen: () => void }) {
    const role = roleText(g)
    const RoleIcon = GROUP_ROLES.find(r => r.value === g.role)?.icon ?? Shield
    return (
        <button type="button" onClick={onOpen} aria-label={`Open ${g.shortName}`}
            className="group flex h-full w-full flex-col gap-3 rounded-xl border border-glass-border bg-canvas p-4 text-left transition-[border-color,box-shadow] hover:border-violet-500/40 hover:shadow-md hover:shadow-violet-500/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50">
            <span className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{g.shortName}</span>
                    {!g.owned && <span className="mt-0.5 block text-[11px] text-ink-muted">Platform group</span>}
                </span>
                {role ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                        <RoleIcon className="h-3 w-3" aria-hidden /> {role}
                    </span>
                ) : (
                    <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">No access here</span>
                )}
            </span>

            <span className="flex items-center gap-2">
                {g.memberPreview.length > 0 && (
                    <span className="flex -space-x-1.5" aria-hidden>
                        {g.memberPreview.slice(0, 4).map(p => (
                            <UserAvatar key={p.id} userId={p.id} name={p.displayName || p.id} hasImage={false}
                                className="h-6 w-6 text-[9px] ring-2 ring-canvas" />
                        ))}
                    </span>
                )}
                <span className="text-xs text-ink-muted">
                    {g.memberCount === 0 ? 'Nobody yet' : `${g.memberCount} ${g.memberCount === 1 ? 'person' : 'people'}`}
                </span>
            </span>

            <DirectoryLine group={g} canManage={canManage} />
        </button>
    )
}

function DirectoryLine({ group: g, canManage }: { group: WorkspaceGroup; canManage: boolean }) {
    if (g.idpLinks.length > 0) {
        return (
            <span className="mt-auto inline-flex min-w-0 items-center gap-1 self-start rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                <Link2 className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">Follows {g.idpLinks[0].idpGroup}{g.idpLinks.length > 1 ? ` +${g.idpLinks.length - 1}` : ''}</span>
            </span>
        )
    }
    if (g.pendingIdpLink) {
        return (
            <span className="mt-auto inline-flex min-w-0 items-center gap-1 self-start rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                <Clock className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">Link to {g.pendingIdpLink.idpGroup} waiting</span>
            </span>
        )
    }
    return (
        <span className={cn('mt-auto inline-flex items-center gap-1 text-[11px] text-ink-muted', canManage && g.owned && 'group-hover:text-violet-700 dark:group-hover:text-violet-300')}>
            <KeyRound className="h-3 w-3" aria-hidden />
            {canManage && g.owned ? 'Link to your identity provider' : 'Not linked to the identity provider'}
        </span>
    )
}
