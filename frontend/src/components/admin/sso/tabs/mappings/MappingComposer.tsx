/**
 * Creating a mapping, as the sentence it actually is.
 *
 * The form this replaces was a grid of labelled selects — "Target type:
 * Role binding (scope + role)", "Scope: Global", "Workspace ID:
 * ws_xxxxxxxx". Every one of those is our schema's word, and two of them
 * asked an operator to type an opaque id they had no way to look up. There
 * is no screen anywhere in this product that shows you a workspace id.
 *
 * A mapping is one sentence — *anyone in GROUP from PROVIDER gets ROLE
 * here* — so it reads as one, with the variable parts as inline controls.
 * The shape of the sentence changes with the target, which is what makes
 * "role binding" versus "group membership" legible without naming either.
 *
 * The ids become pickers off `workspaceService.list()` and
 * `groupsService.list()`, both of which already existed.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Sparkles } from 'lucide-react'

import {
    ssoAdminService, type IdpProvider,
} from '@/services/ssoAdminService'
import {
    permissionsService, type RoleDefinitionResponse,
} from '@/services/permissionsService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { roleVisualFor } from '@/lib/roleVisual'
import { FORBIDDEN_AUTO_GRANT_ROLES, type RoleName } from '@/lib/roleNames'
import { cn } from '@/lib/utils'

type TargetKind = 'role_binding' | 'group_membership'

const inlineSelect =
    'inline-block align-baseline px-2 py-1 rounded-lg border-2 border-black/[0.10] ' +
    'dark:border-white/[0.12] bg-canvas-elevated text-ink text-sm font-medium ' +
    'outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 ' +
    'max-w-[16rem]'

export function MappingComposer({
    providers, onCreated, onError,
}: {
    providers: IdpProvider[]
    onCreated: () => void | Promise<void>
    onError: (m: string) => void
}) {
    const [roles, setRoles] = useState<RoleDefinitionResponse[]>([])
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([])
    const [groups, setGroups] = useState<GroupResponse[]>([])

    const [kind, setKind] = useState<TargetKind>('role_binding')
    const [providerId, setProviderId] = useState('')
    const [idpGroup, setIdpGroup] = useState('')
    const [roleName, setRoleName] = useState('')
    const [workspaceId, setWorkspaceId] = useState('')
    const [targetGroupId, setTargetGroupId] = useState('')
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        // Roles gate the whole sentence; workspaces and groups only matter
        // for one branch each, so a failure there must not block the rest.
        permissionsService.listRoles()
            .then(r => setRoles(r.filter(
                role => !FORBIDDEN_AUTO_GRANT_ROLES.has(role.name as RoleName),
            )))
            .catch(() => setRoles([]))
        workspaceService.list().then(setWorkspaces).catch(() => setWorkspaces([]))
        groupsService.list().then(setGroups).catch(() => setGroups([]))
    }, [])

    const role = useMemo(
        () => roles.find(r => r.name === roleName), [roles, roleName],
    )

    /**
     * Scope is *implied*, never asked. A workspace-template role can only
     * bind at workspace scope and a platform tier only at global — the old
     * form offered both and let the pairing 400 at the server.
     */
    const needsWorkspace = Boolean(
        role && (role.scopeType === 'workspace'
            || role.permissions.some(p => p.startsWith('workspace:'))),
    )

    const ready = kind === 'role_binding'
        ? Boolean(idpGroup.trim() && roleName && (!needsWorkspace || workspaceId))
        : Boolean(idpGroup.trim() && targetGroupId)

    async function submit(e: React.FormEvent) {
        e.preventDefault()
        if (!ready) return
        setBusy(true)
        try {
            if (kind === 'role_binding') {
                await ssoAdminService.createRoleBindingMapping({
                    providerId: providerId || null,
                    idpGroup: idpGroup.trim(),
                    roleName,
                    scopeType: needsWorkspace ? 'workspace' : 'global',
                    scopeId: needsWorkspace ? workspaceId : null,
                })
            } else {
                await ssoAdminService.createGroupMembershipMapping({
                    providerId: providerId || null,
                    idpGroup: idpGroup.trim(),
                    targetGroupId,
                })
            }
            setIdpGroup('')
            setRoleName('')
            setWorkspaceId('')
            setTargetGroupId('')
            await onCreated()
        } catch (err) {
            onError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <form
            onSubmit={submit}
            className="rounded-2xl border-2 border-black/[0.08] dark:border-white/[0.10] p-5"
        >
            <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-4 h-4 text-indigo-500" />
                <h3 className="text-sm font-bold text-ink">New rule</h3>
            </div>

            {/* The sentence. `leading-loose` so inline controls on wrapped
                lines do not collide. */}
            <div className="text-sm text-ink-secondary leading-loose">
                Anyone in the group{' '}
                <input
                    value={idpGroup}
                    onChange={e => setIdpGroup(e.target.value)}
                    placeholder="engineering"
                    aria-label="IdP group name"
                    required
                    className={cn(inlineSelect, 'font-mono w-[11rem]')}
                />
                {' '}from{' '}
                <select
                    value={providerId}
                    onChange={e => setProviderId(e.target.value)}
                    aria-label="Provider"
                    className={inlineSelect}
                >
                    <option value="">any connection</option>
                    {providers.map(p => (
                        <option key={p.id} value={p.id}>
                            {p.displayName || p.slug}
                        </option>
                    ))}
                </select>
                {' '}gets{' '}
                <select
                    value={kind}
                    onChange={e => setKind(e.target.value as TargetKind)}
                    aria-label="What they get"
                    className={inlineSelect}
                >
                    <option value="role_binding">a role</option>
                    <option value="group_membership">membership of a group</option>
                </select>

                {kind === 'role_binding' ? (
                    <>
                        {': '}
                        <select
                            value={roleName}
                            onChange={e => { setRoleName(e.target.value); setWorkspaceId('') }}
                            aria-label="Role"
                            required
                            className={inlineSelect}
                        >
                            <option value="">choose a role…</option>
                            <optgroup label="Organization-wide">
                                {roles.filter(r => r.isSystem
                                    && !r.permissions.some(p => p.startsWith('workspace:')))
                                    .map(r => (
                                        <option key={r.name} value={r.name}>
                                            {roleVisualFor(r.name).label}
                                        </option>
                                    ))}
                            </optgroup>
                            <optgroup label="Within one workspace">
                                {roles.filter(r => r.isSystem
                                    && r.permissions.some(p => p.startsWith('workspace:')))
                                    .map(r => (
                                        <option key={r.name} value={r.name}>
                                            {roleVisualFor(r.name).label}
                                        </option>
                                    ))}
                            </optgroup>
                            {roles.some(r => !r.isSystem) && (
                                <optgroup label="Custom roles">
                                    {roles.filter(r => !r.isSystem).map(r => (
                                        <option key={r.name} value={r.name}>{r.name}</option>
                                    ))}
                                </optgroup>
                            )}
                        </select>
                        {needsWorkspace && (
                            <>
                                {' in '}
                                <select
                                    value={workspaceId}
                                    onChange={e => setWorkspaceId(e.target.value)}
                                    aria-label="Workspace"
                                    required
                                    className={inlineSelect}
                                >
                                    <option value="">choose a workspace…</option>
                                    {workspaces.map(w => (
                                        <option key={w.id} value={w.id}>{w.name}</option>
                                    ))}
                                </select>
                            </>
                        )}
                        {role && !needsWorkspace && ' across the whole organization'}
                    </>
                ) : (
                    <>
                        {': '}
                        <select
                            value={targetGroupId}
                            onChange={e => setTargetGroupId(e.target.value)}
                            aria-label="Internal group"
                            required
                            className={inlineSelect}
                        >
                            <option value="">choose a group…</option>
                            {groups.map(g => (
                                <option key={g.id} value={g.id}>
                                    {g.name}{g.memberCount ? ` (${g.memberCount})` : ''}
                                </option>
                            ))}
                        </select>
                        {' — and whatever that group grants'}
                    </>
                )}
                {'.'}
            </div>

            {role?.description && (
                <p className="mt-3 text-[11px] text-ink-muted leading-relaxed">
                    <span className="font-medium text-ink-secondary">
                        {roleVisualFor(role.name).label}:
                    </span>{' '}
                    {role.description}
                </p>
            )}

            {kind === 'group_membership' && !groups.length && (
                <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-400">
                    No internal groups exist yet — create one under Admin → Groups
                    first, or map straight to a role instead.
                </p>
            )}

            <button
                type="submit"
                disabled={!ready || busy}
                className={cn(
                    'mt-4 inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium transition-colors duration-150',
                    ready && !busy
                        ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md'
                        : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                )}
            >
                {busy
                    ? <><Loader2 className="w-4 h-4 animate-spin" />Creating…</>
                    : <><Plus className="w-4 h-4" />Create rule</>}
            </button>
        </form>
    )
}
