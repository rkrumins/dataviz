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
import { ArrowRight, Check, Loader2, Plus, ShieldAlert, Users } from 'lucide-react'

import { ssoAdminService, type IdpProvider } from '@/services/ssoAdminService'
import {
    permissionsService, type RoleDefinitionResponse,
} from '@/services/permissionsService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { roleVisualFor } from '@/lib/roleVisual'
import { privilegedRuleBlock } from './privilegedRule'
import { RuleTarget, providerLabel } from './MappingGroupCard'
import type { IdpGroupMapping } from '@/services/ssoAdminService'
import { FORBIDDEN_AUTO_GRANT_ROLES, type RoleName } from '@/lib/roleNames'
import { cn } from '@/lib/utils'

type TargetKind = 'role_binding' | 'group_membership'

const control =
    'w-full h-10 px-3 rounded-xl border border-glass-border bg-canvas ' +
    'text-ink text-sm outline-none transition-colors duration-150 ' +
    'focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10'

/**
 * One slot of the rule.
 *
 * `filled` is not decoration: four identical-looking controls give no sense
 * of how much of the rule is done, and the operator is composing a sentence
 * whose parts arrive in order. A settled slot goes quiet and gets a tick;
 * the one still waiting keeps the eye.
 */
function Slot({
    label, filled, children,
}: {
    label: string
    filled: boolean
    children: React.ReactNode
}) {
    return (
        <label className="block min-w-0">
            <span className={cn(
                'flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider mb-1.5 transition-colors duration-150',
                filled ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-muted',
            )}>
                {label}
                {filled && <Check className="w-2.5 h-2.5" />}
            </span>
            <div className={cn(
                'rounded-xl transition-shadow duration-150',
                filled && 'ring-1 ring-emerald-500/25',
            )}>
                {children}
            </div>
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

    /** How much of the rule is answered. The connection is deliberately not
     *  counted — "any connection" is a real answer, not a blank. */
    const needed = kind === 'role_binding' ? (needsWorkspace ? 3 : 2) : 2
    const answered = [
        Boolean(idpGroup.trim()),
        kind === 'role_binding' ? Boolean(roleName) : Boolean(targetGroupId),
        ...(kind === 'role_binding' && needsWorkspace ? [Boolean(workspaceId)] : []),
    ].filter(Boolean).length

    /**
     * The rule as the row it will become, or null while it is incomplete.
     *
     * Shaped as an `IdpGroupMapping` so the saved renderer can take it
     * unchanged. `id` is a sentinel — nothing reads it, but leaving it off
     * would mean lying about the type.
     */
    const draftRow: IdpGroupMapping | null = useMemo(() => {
        if (!ready) return null
        return {
            id: '__draft__',
            providerId: providerId || null,
            idpGroup: idpGroup.trim(),
            targetType: kind,
            roleName: kind === 'role_binding' ? roleName : null,
            scopeType: kind === 'role_binding'
                ? (needsWorkspace ? 'workspace' : 'global') : null,
            scopeId: kind === 'role_binding' && needsWorkspace ? workspaceId : null,
            targetGroupId: kind === 'group_membership' ? targetGroupId : null,
        } as IdpGroupMapping
    }, [ready, providerId, idpGroup, kind, roleName, needsWorkspace,
        workspaceId, targetGroupId])

    /** The rule in plain language — the preview while it is incomplete, and
     *  the restatement under the row once it is not. */
    const draftSentence = sentence({
        idpGroup, kind, role, workspaces, workspaceId,
        groups, targetGroupId, providers, providerId,
    })

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
                <Slot label="Anyone in" filled={Boolean(idpGroup.trim())}>
                    <input
                        value={idpGroup}
                        onChange={e => setIdpGroup(e.target.value)}
                        placeholder="engineering"
                        aria-label="IdP group name"
                        required
                        className={cn(control, 'font-mono')}
                    />
                </Slot>

                <Slot label="From" filled={Boolean(providerId)}>
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

                <Slot label="Gets" filled>
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
                    <Slot label="Which role" filled={Boolean(roleName)}>
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
                    <Slot label="Which group" filled={Boolean(targetGroupId)}>
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
                    <Slot label="In which workspace" filled={Boolean(workspaceId)}>
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

            {/*
              * The preview, rendered through the saved rule's own component.
              *
              * A grey sentence claiming to be "exactly what gets saved" asks
              * to be taken on trust. Rendering the draft through `RuleTarget`
              * — the same code the card below uses — makes the claim literal:
              * what you see here is the row you are about to create, in the
              * place it will appear, and the two cannot drift because there
              * is only one renderer.
              */}
            <div className={cn(
                'mt-4 rounded-xl border transition-colors duration-200',
                ready
                    ? 'border-emerald-500/30 bg-emerald-500/[0.04]'
                    : 'border-dashed border-glass-border bg-black/[0.015] dark:bg-white/[0.02]',
            )}>
                <div className="flex items-center justify-between gap-2 px-4 pt-3">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                        {ready ? 'Will be created as' : 'Preview'}
                    </span>
                    <span className={cn(
                        'text-[10px] font-medium',
                        ready ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-muted',
                    )}>
                        {ready ? 'Ready' : `${answered} of ${needed} chosen`}
                    </span>
                </div>

                <div className="px-4 py-3">
                    {draftRow ? (
                        // Deliberately the same three-part row as MappingGroupCard:
                        // group heading, connection, arrow, target.
                        <div className="flex items-center gap-3 min-w-0">
                            <span className="inline-flex items-center gap-1.5 shrink-0">
                                <Users className="w-3.5 h-3.5 text-ink-muted" />
                                <span className="font-mono text-xs font-semibold text-ink">
                                    {idpGroup.trim()}
                                </span>
                            </span>
                            <span className="text-[11px] text-ink-muted shrink-0 truncate max-w-[10rem]">
                                {providerLabel(draftRow, providers)}
                            </span>
                            <ArrowRight className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                            <span className="min-w-0 flex-1">
                                <RuleTarget
                                    row={draftRow}
                                    workspaces={workspaces}
                                    groups={groups}
                                    providers={providers}
                                />
                            </span>
                        </div>
                    ) : (
                        <p className="flex items-center gap-1.5 text-xs text-ink-muted">
                            <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                            {draftSentence}
                        </p>
                    )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-3">
                    {/* Only once the row is up: before that the sentence IS
                        the preview above, and repeating it would be two
                        voices saying the same thing. */}
                    <p className="text-[11px] text-ink-muted min-w-0">
                        {draftRow ? draftSentence : ''}
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

/** The same rule in plain language, under the row. The row shows the
 *  shape; this says it out loud, which is what catches a mapping that is
 *  structurally valid and semantically wrong. */
function sentence({
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
