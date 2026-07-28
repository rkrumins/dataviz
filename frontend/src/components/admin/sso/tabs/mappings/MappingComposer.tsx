/**
 * Creating a rule.
 *
 * The form this replaces was a grid of labelled selects using our schema's
 * words — "Target type: Role binding (scope + role)" — with two fields
 * asking for opaque ids (`ws_xxxxxxxx`, `grp_xxxxxxxx`) that nothing in
 * this product will show you. Those are gone: the ids are pickers off
 * `workspaceService.list()` and `groupsService.list()`, both of which
 * already existed.
 *
 * The pass after that swung too far and put live `<select>`s inside a
 * flowing sentence. The reading order was right — *anyone in GROUP from
 * PROVIDER gets ROLE* is how the rule is thought about, and it makes the
 * two target types legible without naming either — but controls inside
 * running prose wrap mid-phrase and read as a broken form.
 *
 * So the reading order survives as the **column order**, on one baseline,
 * and the sentence survives as a preview line underneath. That line does
 * a second job the layout never could: it confirms what will be saved,
 * with the workspace and role resolved to their names.
 *
 * Scope is implied throughout, never asked. A workspace-template role can
 * only bind at workspace scope and a platform tier only at global; the
 * original form offered both and let the pairing 400 at the server.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Loader2, Plus, ShieldAlert } from 'lucide-react'

import { ssoAdminService, type IdpProvider } from '@/services/ssoAdminService'
import {
    permissionsService, type RoleDefinitionResponse,
} from '@/services/permissionsService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { roleVisualFor } from '@/lib/roleVisual'
import { privilegedRuleBlock } from './privilegedRule'
import { FORBIDDEN_AUTO_GRANT_ROLES, type RoleName } from '@/lib/roleNames'
import { cn } from '@/lib/utils'

type TargetKind = 'role_binding' | 'group_membership'

const control =
    'w-full h-10 px-3 rounded-xl border border-glass-border bg-canvas ' +
    'text-ink text-sm outline-none transition-colors duration-150 ' +
    'focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10'

function Slot({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block min-w-0">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                {label}
            </span>
            {children}
        </label>
    )
}

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
        // Roles gate the whole rule; workspaces and groups matter to one
        // branch each, so a failure there must not block the rest.
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

    const needsWorkspace = Boolean(
        role && (role.scopeType === 'workspace'
            || role.permissions.some(p => p.startsWith('workspace:'))),
    )

    /** The server refuses these two shapes outright; catching them here
     *  turns a 400-after-composing into a sentence beside the control. */
    const privileged = useMemo(
        () => (kind === 'role_binding'
            ? privilegedRuleBlock(roleName, providerId, providers)
            : null),
        [kind, roleName, providerId, providers],
    )

    const ready = !privileged && (kind === 'role_binding'
        ? Boolean(idpGroup.trim() && roleName && (!needsWorkspace || workspaceId))
        : Boolean(idpGroup.trim() && targetGroupId))

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
        <form onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Slot label="Anyone in">
                    <input
                        value={idpGroup}
                        onChange={e => setIdpGroup(e.target.value)}
                        placeholder="engineering"
                        aria-label="IdP group name"
                        required
                        className={cn(control, 'font-mono')}
                    />
                </Slot>

                <Slot label="From">
                    <select
                        value={providerId}
                        onChange={e => setProviderId(e.target.value)}
                        aria-label="Provider"
                        className={control}
                    >
                        <option value="">Any connection</option>
                        {providers.map(p => (
                            <option key={p.id} value={p.id}>
                                {p.displayName || p.slug}
                            </option>
                        ))}
                    </select>
                </Slot>

                <Slot label="Gets">
                    <select
                        value={kind}
                        onChange={e => setKind(e.target.value as TargetKind)}
                        aria-label="What they get"
                        className={control}
                    >
                        <option value="role_binding">A role</option>
                        <option value="group_membership">Membership of a group</option>
                    </select>
                </Slot>

                {/* The varying slot. Which control appears here is what makes
                    the two target types legible without naming either. */}
                {kind === 'role_binding' ? (
                    <Slot label="Which role">
                        <select
                            value={roleName}
                            onChange={e => { setRoleName(e.target.value); setWorkspaceId('') }}
                            aria-label="Role"
                            required
                            className={control}
                        >
                            <option value="">Choose a role…</option>
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
                    </Slot>
                ) : (
                    <Slot label="Which group">
                        <select
                            value={targetGroupId}
                            onChange={e => setTargetGroupId(e.target.value)}
                            aria-label="Internal group"
                            required
                            className={control}
                        >
                            <option value="">Choose a group…</option>
                            {groups.map(g => (
                                <option key={g.id} value={g.id}>
                                    {g.name}{g.memberCount ? ` (${g.memberCount})` : ''}
                                </option>
                            ))}
                        </select>
                    </Slot>
                )}

                {needsWorkspace && (
                    <Slot label="In which workspace">
                        <select
                            value={workspaceId}
                            onChange={e => setWorkspaceId(e.target.value)}
                            aria-label="Workspace"
                            required
                            className={control}
                        >
                            <option value="">Choose a workspace…</option>
                            {workspaces.map(w => (
                                <option key={w.id} value={w.id}>{w.name}</option>
                            ))}
                        </select>
                    </Slot>
                )}
            </div>

            {privileged && (
                <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                    <ShieldAlert className="w-3.5 h-3.5 mt-px shrink-0" />
                    <span>
                        {privileged.message}
                        {privileged.suggestion && (
                            <span className="block mt-0.5 text-ink-muted">
                                {privileged.suggestion}
                            </span>
                        )}
                    </span>
                </p>
            )}

            {/* The sentence, now doing the job it is actually good at:
                confirming what is about to be written, with ids resolved. */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="flex items-start gap-1.5 text-xs text-ink-secondary min-w-0">
                    <ArrowRight className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" />
                    <span>
                        {preview({
                            idpGroup, kind, role, workspaces, workspaceId,
                            groups, targetGroupId, providers, providerId,
                        })}
                    </span>
                </p>
                <button
                    type="submit"
                    disabled={!ready || busy}
                    className={cn(
                        'shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors duration-150',
                        ready && !busy
                            ? 'bg-accent-lineage text-white hover:brightness-110 shadow-sm shadow-accent-lineage/20'
                            : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                    )}
                >
                    {busy
                        ? <><Loader2 className="w-4 h-4 animate-spin" />Creating…</>
                        : <><Plus className="w-4 h-4" />Create rule</>}
                </button>
            </div>

            {role?.description && (
                <p className="mt-2 text-[11px] text-ink-muted leading-relaxed">
                    <span className="font-medium text-ink-secondary">
                        {roleVisualFor(role.name).label}:
                    </span>{' '}
                    {role.description}
                </p>
            )}

            {kind === 'group_membership' && !groups.length && (
                <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                    No internal groups exist yet — create one under Admin → Groups
                    first, or map straight to a role instead.
                </p>
            )}
        </form>
    )
}

/** The rule as a sentence, with every id resolved to the name it was
 *  picked by. Falls back to a prompt while it is still incomplete. */
function preview({
    idpGroup, kind, role, workspaces, workspaceId,
    groups, targetGroupId, providers, providerId,
}: {
    idpGroup: string
    kind: TargetKind
    role?: RoleDefinitionResponse
    workspaces: WorkspaceResponse[]
    workspaceId: string
    groups: GroupResponse[]
    targetGroupId: string
    providers: IdpProvider[]
    providerId: string
}): string {
    // Describe as much as is known at every stage rather than waiting for
    // the whole rule. Someone who picks a role first should learn from this
    // line that it is organization-wide, before they have named a group.
    const group = idpGroup.trim() || '…'

    const from = providerId
        ? ` from ${providers.find(p => p.id === providerId)?.displayName ?? 'that connection'}`
        : ''

    if (kind === 'group_membership') {
        const g = groups.find(x => x.id === targetGroupId)
        return g
            ? `Anyone in ${group}${from} joins ${g.name}, and gets whatever it grants.`
            : `Anyone in ${group}${from} joins… choose a group.`
    }

    if (!role) return `Anyone in ${group}${from} gets… choose a role.`

    const label = roleVisualFor(role.name).label
    const needsWorkspace = role.scopeType === 'workspace'
        || role.permissions.some(p => p.startsWith('workspace:'))
    if (!needsWorkspace) {
        return `Anyone in ${group}${from} gets ${label} across the whole organization.`
    }
    const w = workspaces.find(x => x.id === workspaceId)
    return w
        ? `Anyone in ${group}${from} gets ${label} in ${w.name}.`
        : `Anyone in ${group}${from} gets ${label} in… choose a workspace.`
}
