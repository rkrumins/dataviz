/**
 * MappingsTab — IdP group → role or internal group.
 *
 * Reconciliation runs on every sign-in and refresh, so what is listed
 * here is what people actually get.
 */
import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'

import {
    ssoAdminService,
    type IdpGroupMapping,
    type IdpProvider,
} from '@/services/ssoAdminService'
import { permissionsService, type RoleDefinitionResponse } from '@/services/permissionsService'
import { roleVisualFor } from '@/lib/roleVisual'
import { FORBIDDEN_AUTO_GRANT_ROLES, type RoleName } from '@/lib/roleNames'
import { cn } from '@/lib/utils'
import { ErrorBanner } from './ErrorBanner'

export function MappingsTab() {
    const [rows, setRows] = useState<IdpGroupMapping[]>([])
    const [providers, setProviders] = useState<IdpProvider[]>([])
    // Available roles come from the live ``/admin/roles`` catalogue so
    // the picker always reflects the current taxonomy (organization
    // access + workspace access + custom roles). The old free-text
    // input forced
    // admins to know exact role names by heart and produced a 400 on
    // typos — a dropdown of validated choices is correct UX.
    const [availableRoles, setAvailableRoles] = useState<RoleDefinitionResponse[]>([])
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [target, setTarget] = useState<'role_binding' | 'group_membership'>('role_binding')

    // role_binding form fields
    const [providerId, setProviderId] = useState('')
    const [idpGroup, setIdpGroup] = useState('')
    const [roleName, setRoleName] = useState('')
    const [scopeType, setScopeType] = useState<'global' | 'workspace'>('global')
    const [scopeId, setScopeId] = useState('')

    // group_membership form fields
    const [targetGroupId, setTargetGroupId] = useState('')

    const refresh = useCallback(async () => {
        try {
            const [m, p, r] = await Promise.all([
                ssoAdminService.listGroupMappings(),
                ssoAdminService.listProviders(),
                permissionsService.listRoles(),
            ])
            setRows(m)
            setProviders(p)
            // Drop ``system:admin``-equivalent roles that the BE refuses
            // to auto-grant via SSO (per ``FORBIDDEN_AUTO_ROLE`` in
            // ``idp_group_mapping_repo``). super_admin is the only one
            // currently on the list.
            setAvailableRoles(r.filter(role => !FORBIDDEN_AUTO_GRANT_ROLES.has(role.name as RoleName)))
            setError(null)
        } catch (err) {
            setError((err as Error).message)
        }
    }, [])

    useEffect(() => { void refresh() }, [refresh])

    // Auto-flip the scope picker to match the selected role. Workspace-
    // template roles only make sense at workspace scope; platform
    // tiers only at global scope. The free-text version let admins
    // pair them wrong and 400 at the BE.
    const selectedRoleObj = availableRoles.find(r => r.name === roleName)
    const roleIsWorkspaceScoped = selectedRoleObj
        ? selectedRoleObj.scopeType === 'workspace'
            || selectedRoleObj.permissions.some(p => p.startsWith('workspace:'))
        : false
    useEffect(() => {
        if (!selectedRoleObj) return
        // Only force-flip when the user hasn't deliberately picked the
        // other scope; otherwise we'd fight their choice on every key
        // press. The "hint" is presence of ``workspace:*`` perms on the
        // role — if it's a custom role with mixed perms, we leave the
        // scope alone.
        if (roleIsWorkspaceScoped && scopeType === 'global') {
            setScopeType('workspace')
        } else if (!roleIsWorkspaceScoped && scopeType === 'workspace') {
            setScopeType('global')
            setScopeId('')
        }
    }, [selectedRoleObj, roleIsWorkspaceScoped, scopeType])

    async function create(e: React.FormEvent) {
        e.preventDefault()
        setBusy(true)
        try {
            if (target === 'role_binding') {
                await ssoAdminService.createRoleBindingMapping({
                    providerId: providerId || null,
                    idpGroup,
                    roleName,
                    scopeType,
                    scopeId: scopeType === 'global' ? null : scopeId,
                })
            } else {
                await ssoAdminService.createGroupMembershipMapping({
                    providerId: providerId || null,
                    idpGroup,
                    targetGroupId,
                })
            }
            await refresh()
            setIdpGroup('')
            setRoleName('')
            setScopeId('')
            setTargetGroupId('')
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    async function remove(id: string) {
        if (!confirm('Delete this mapping?')) return
        setBusy(true)
        try {
            await ssoAdminService.deleteMapping(id)
            await refresh()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="space-y-4">
            {error && <ErrorBanner message={error} />}
            <h2 className="text-base font-semibold">IdP group → target mappings</h2>
            <form
                onSubmit={create}
                className="p-4 rounded-xl border border-white/10 bg-white/5 space-y-3"
            >
                <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs">
                        Provider (optional)
                        <select
                            className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 text-xs"
                            value={providerId}
                            onChange={(e) => setProviderId(e.target.value)}
                        >
                            <option value="">(any provider)</option>
                            {providers.map((p) => (
                                <option key={p.id} value={p.id}>{p.displayName} — {p.slug}</option>
                            ))}
                        </select>
                    </label>
                    <label className="text-xs">
                        IdP group name
                        <input
                            className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono text-xs"
                            value={idpGroup}
                            onChange={(e) => setIdpGroup(e.target.value)}
                            placeholder="engineering"
                            required
                        />
                    </label>
                    <label className="text-xs col-span-2">
                        Target type
                        <select
                            className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 text-xs"
                            value={target}
                            onChange={(e) => setTarget(e.target.value as 'role_binding' | 'group_membership')}
                        >
                            <option value="role_binding">Role binding (scope + role)</option>
                            <option value="group_membership">Group membership (internal Group)</option>
                        </select>
                    </label>
                    {target === 'role_binding' ? (
                        <>
                            <label className="text-xs">
                                Role
                                <select
                                    className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 text-xs"
                                    value={roleName}
                                    onChange={(e) => setRoleName(e.target.value)}
                                    required
                                >
                                    <option value="">Select a role…</option>
                                    <optgroup label="Organization-wide access">
                                        {availableRoles
                                            .filter(r => r.isSystem
                                                && !r.permissions.some(p => p.startsWith('workspace:')))
                                            .map(r => (
                                                <option key={r.name} value={r.name}>
                                                    {roleVisualFor(r.name).label}
                                                </option>
                                            ))}
                                    </optgroup>
                                    <optgroup label="Workspace-specific access">
                                        {availableRoles
                                            .filter(r => r.isSystem
                                                && r.permissions.some(p => p.startsWith('workspace:')))
                                            .map(r => (
                                                <option key={r.name} value={r.name}>
                                                    {roleVisualFor(r.name).label}
                                                </option>
                                            ))}
                                    </optgroup>
                                    {availableRoles.some(r => !r.isSystem) && (
                                        <optgroup label="Custom roles">
                                            {availableRoles
                                                .filter(r => !r.isSystem)
                                                .map(r => (
                                                    <option key={r.name} value={r.name}>
                                                        {r.name}
                                                    </option>
                                                ))}
                                        </optgroup>
                                    )}
                                </select>
                                {selectedRoleObj?.description && (
                                    <p className="mt-1 text-[10px] text-ink-muted/80">
                                        {selectedRoleObj.description}
                                    </p>
                                )}
                            </label>
                            <label className="text-xs">
                                Scope
                                <select
                                    className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 text-xs disabled:opacity-60"
                                    value={scopeType}
                                    onChange={(e) => setScopeType(e.target.value as 'global' | 'workspace')}
                                    // Scope is implied by the role selection — workspace-
                                    // template roles must bind at workspace scope, platform
                                    // tiers at global. The picker auto-flips above; we
                                    // disable manual override so they can't drift apart.
                                    disabled={selectedRoleObj?.isSystem}
                                    title={selectedRoleObj?.isSystem
                                        ? 'Scope is fixed by the selected built-in role.'
                                        : undefined}
                                >
                                    <option value="global">Global</option>
                                    <option value="workspace">Workspace</option>
                                </select>
                            </label>
                            {scopeType === 'workspace' && (
                                <label className="text-xs col-span-2">
                                    Workspace ID
                                    <input
                                        className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono text-xs"
                                        value={scopeId}
                                        onChange={(e) => setScopeId(e.target.value)}
                                        placeholder="ws_xxxxxxxx"
                                        required
                                    />
                                </label>
                            )}
                        </>
                    ) : (
                        <label className="text-xs col-span-2">
                            Target group ID
                            <input
                                className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono text-xs"
                                value={targetGroupId}
                                onChange={(e) => setTargetGroupId(e.target.value)}
                                placeholder="grp_xxxxxxxx"
                                required
                            />
                        </label>
                    )}
                </div>
                <button
                    type="submit"
                    disabled={busy}
                    className="px-4 py-2 rounded-lg bg-accent-lineage text-white text-sm disabled:opacity-50"
                >
                    Create mapping
                </button>
            </form>

            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-ink-muted">
                        <th className="py-2">Provider</th>
                        <th>IdP group</th>
                        <th>Target</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((m) => (
                        <tr key={m.id} className="border-t border-white/10">
                            <td className="py-2 font-mono text-xs">
                                {m.providerId
                                    ? providers.find((p) => p.id === m.providerId)?.slug ?? m.providerId
                                    : '(any)'}
                            </td>
                            <td className="font-mono text-xs">{m.idpGroup}</td>
                            <td className="text-xs">
                                {m.targetType === 'role_binding' ? (
                                    <span className="flex items-center gap-1.5">
                                        <span className={cn(
                                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border',
                                            roleVisualFor(m.roleName ?? '').badge,
                                        )}>
                                            {roleVisualFor(m.roleName ?? '').label}
                                        </span>
                                        <span className="text-ink-muted">
                                            @ {m.scopeType}{m.scopeId ? `/${m.scopeId}` : ''}
                                        </span>
                                    </span>
                                ) : (
                                    `group ${m.targetGroupId}`
                                )}
                            </td>
                            <td className="text-right">
                                <button
                                    onClick={() => remove(m.id)}
                                    disabled={busy}
                                    className="text-red-400 hover:text-red-300"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
