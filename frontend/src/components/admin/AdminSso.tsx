/**
 * AdminSso — minimal admin surface for SSO Phase 3.
 *
 * Two tabs:
 *   * Providers — list + create / enable / disable / delete
 *   * Group mappings — list + create (role_binding or group_membership)
 *
 * Claim-mapping editing + the /test endpoint live behind a "Preview"
 * link on each provider row; the editor itself is plain JSON for now
 * (richer UX is a follow-up).
 *
 * Gated by RequirePermission perm="system:admin" in the route.
 */
import { useCallback, useEffect, useState } from 'react'
import { Trash2, Plus, Power, AlertCircle, Beaker, Search, Settings, ShieldOff } from 'lucide-react'

import {
    ssoAdminService,
    type AuthConfig,
    type IdpGroupMapping,
    type IdpProvider,
    type UserSummary,
} from '@/services/ssoAdminService'
import { permissionsService, type RoleDefinitionResponse } from '@/services/permissionsService'
import { roleVisualFor } from '@/lib/roleVisual'
import { cn } from '@/lib/utils'

type Tab = 'providers' | 'mappings' | 'settings' | 'lookup'


function ErrorBanner({ message }: { message: string }) {
    return (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{message}</span>
        </div>
    )
}


// ── Providers tab ──────────────────────────────────────────────────


function ProvidersTab() {
    const [rows, setRows] = useState<IdpProvider[]>([])
    const [error, setError] = useState<string | null>(null)
    const [showCreate, setShowCreate] = useState(false)
    const [busy, setBusy] = useState(false)

    const refresh = useCallback(async () => {
        try {
            setRows(await ssoAdminService.listProviders())
            setError(null)
        } catch (err) {
            setError((err as Error).message)
        }
    }, [])

    useEffect(() => { void refresh() }, [refresh])

    async function toggleEnabled(p: IdpProvider) {
        setBusy(true)
        try {
            await ssoAdminService.updateProvider(p.id, { enabled: !p.enabled })
            await refresh()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    async function remove(p: IdpProvider) {
        if (!confirm(`Delete provider ${p.slug}? Linked users must unlink first.`)) return
        setBusy(true)
        try {
            await ssoAdminService.deleteProvider(p.id)
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
            <div className="flex justify-between items-center">
                <h2 className="text-base font-semibold">IdP providers</h2>
                <button
                    onClick={() => setShowCreate((v) => !v)}
                    className="px-3 py-1.5 rounded-lg bg-accent-lineage text-white text-sm flex items-center gap-1"
                >
                    <Plus className="w-4 h-4" />
                    {showCreate ? 'Cancel' : 'Add provider'}
                </button>
            </div>
            {showCreate && (
                <CreateProviderForm
                    onCreated={() => { setShowCreate(false); void refresh() }}
                    onError={setError}
                />
            )}
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-ink-muted">
                        <th className="py-2">Slug</th>
                        <th>Display</th>
                        <th>Kind</th>
                        <th>Linking</th>
                        <th>Enabled</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((p) => (
                        <tr key={p.id} className="border-t border-white/10">
                            <td className="py-2 font-mono text-xs">{p.slug}</td>
                            <td>{p.displayName}</td>
                            <td>{p.kind}</td>
                            <td className="text-xs">{p.linkingPolicy}</td>
                            <td>
                                <button
                                    onClick={() => toggleEnabled(p)}
                                    disabled={busy}
                                    className={
                                        p.enabled
                                            ? "text-emerald-400 text-xs"
                                            : "text-ink-muted text-xs"
                                    }
                                >
                                    <Power className="inline w-3.5 h-3.5 mr-1" />
                                    {p.enabled ? 'on' : 'off'}
                                </button>
                            </td>
                            <td className="text-right">
                                <button
                                    onClick={() => remove(p)}
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


function CreateProviderForm({
    onCreated, onError,
}: {
    onCreated: () => void
    onError: (e: string) => void
}) {
    const [slug, setSlug] = useState('')
    const [displayName, setDisplayName] = useState('')
    const [kind, setKind] = useState<'oidc' | 'saml2' | 'custom'>('oidc')
    const [settingsJson, setSettingsJson] = useState('{\n  "issuer": "",\n  "client_id": "",\n  "client_secret": "",\n  "redirect_uri": ""\n}')
    const [claimMappingJson, setClaimMappingJson] = useState('{}')
    const [linkingPolicy, setLinkingPolicy] = useState<'strict' | 'allow_verified' | 'manual_only' | 'disabled'>('strict')
    const [busy, setBusy] = useState(false)

    async function submit(e: React.FormEvent) {
        e.preventDefault()
        let settings: Record<string, unknown> = {}
        let claimMapping: Record<string, unknown> = {}
        try {
            settings = JSON.parse(settingsJson)
            claimMapping = JSON.parse(claimMappingJson)
        } catch (err) {
            onError(`JSON parse error: ${(err as Error).message}`)
            return
        }
        setBusy(true)
        try {
            await ssoAdminService.createProvider({
                slug, displayName, kind, settings,
                claimMapping, linkingPolicy,
            })
            onCreated()
        } catch (err) {
            onError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <form
            onSubmit={submit}
            className="p-4 rounded-xl border border-white/10 bg-white/5 space-y-3"
        >
            <div className="grid grid-cols-2 gap-3">
                <label className="text-xs">
                    Slug (URL-safe)
                    <input
                        className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono text-xs"
                        value={slug}
                        onChange={(e) => setSlug(e.target.value)}
                        placeholder="entra-staff"
                        required
                    />
                </label>
                <label className="text-xs">
                    Display name
                    <input
                        className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 text-xs"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Corporate Entra ID"
                        required
                    />
                </label>
                <label className="text-xs">
                    Kind
                    <select
                        className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 text-xs"
                        value={kind}
                        onChange={(e) => setKind(e.target.value as 'oidc' | 'saml2' | 'custom')}
                    >
                        <option value="oidc">OIDC</option>
                        <option value="saml2">SAML 2.0</option>
                        <option value="custom">Custom (dev)</option>
                    </select>
                </label>
                <label className="text-xs">
                    Linking policy
                    <select
                        className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 text-xs"
                        value={linkingPolicy}
                        onChange={(e) => setLinkingPolicy(e.target.value as 'strict' | 'allow_verified' | 'manual_only' | 'disabled')}
                    >
                        <option value="strict">Strict (default)</option>
                        <option value="allow_verified">Allow verified</option>
                        <option value="manual_only">Manual only</option>
                        <option value="disabled">Disabled (no linking)</option>
                    </select>
                </label>
            </div>
            <label className="block text-xs">
                Settings (encrypted JSON)
                <textarea
                    className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono text-xs"
                    rows={8}
                    value={settingsJson}
                    onChange={(e) => setSettingsJson(e.target.value)}
                />
            </label>
            <label className="block text-xs">
                Claim mapping (JSON; empty = use kind defaults)
                <textarea
                    className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono text-xs"
                    rows={5}
                    value={claimMappingJson}
                    onChange={(e) => setClaimMappingJson(e.target.value)}
                />
            </label>
            <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 rounded-lg bg-accent-lineage text-white text-sm disabled:opacity-50"
            >
                Create provider
            </button>
        </form>
    )
}


// ── Group mappings tab ──────────────────────────────────────────────


function MappingsTab() {
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
            setAvailableRoles(r.filter(role => role.name !== 'super_admin'))
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


// ── Settings tab (platform posture switches) ────────────────────────


function SettingsTab() {
    const [cfg, setCfg] = useState<AuthConfig | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [confirm, setConfirm] = useState<keyof AuthConfig | null>(null)

    const refresh = useCallback(async () => {
        try {
            setCfg(await ssoAdminService.getAuthConfig())
            setError(null)
        } catch (err) {
            setError((err as Error).message)
        }
    }, [])

    useEffect(() => { void refresh() }, [refresh])

    async function applyToggle<K extends keyof AuthConfig>(field: K, value: AuthConfig[K]) {
        if (!cfg) return
        setBusy(true)
        try {
            const next = await ssoAdminService.updateAuthConfig({
                [field]: value,
                expectedVersion: cfg.version,
            } as never)
            setCfg(next)
            setError(null)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
            setConfirm(null)
        }
    }

    if (cfg === null && error === null) {
        return <div className="p-4 text-ink-muted text-sm">Loading…</div>
    }

    const toggles: {
        field: keyof AuthConfig
        label: string
        description: string
        destructive: boolean
    }[] = [
        {
            field: 'ssoEnabled',
            label: 'SSO enabled',
            description:
                'Master kill-switch. When off, /auth/providers returns [] and all /auth/{slug}/* routes return 404. Individual provider rows keep their settings; toggling this back on restores them.',
            destructive: false,
        },
        {
            field: 'allowLocalLogin',
            label: 'Allow local login',
            description:
                'When off, POST /auth/login returns 403 (SSO-only mode). Refused if it would lock out any active admin without an SSO identity.',
            destructive: true,
        },
        {
            field: 'allowJitProvisioning',
            label: 'Allow JIT provisioning',
            description:
                'When off, SSO logins for unknown subjects raise jit_disabled instead of creating a new user. Existing users keep working; admins must pre-create accounts (or invite).',
            destructive: false,
        },
    ]

    return (
        <div className="space-y-4">
            {error && <ErrorBanner message={error} />}
            <h2 className="text-base font-semibold">Platform SSO posture</h2>
            <p className="text-xs text-ink-muted">
                Version {cfg?.version ?? '—'} · last updated {cfg?.updatedAt ?? '—'}
            </p>
            <div className="space-y-3">
                {toggles.map((t) => {
                    const value = cfg ? (cfg[t.field] as boolean) : false
                    const wantsConfirm = t.destructive && value
                    return (
                        <div
                            key={t.field}
                            className="p-4 rounded-xl border border-white/10 bg-white/5 flex items-start gap-4"
                        >
                            <button
                                disabled={busy || cfg === null}
                                onClick={() => {
                                    if (wantsConfirm) {
                                        setConfirm(t.field)
                                    } else {
                                        void applyToggle(t.field, !value as never)
                                    }
                                }}
                                className={`mt-0.5 w-10 h-6 rounded-full transition-colors ${value ? 'bg-emerald-500' : 'bg-ink-muted/30'} disabled:opacity-50`}
                                aria-pressed={value}
                                aria-label={t.label}
                            >
                                <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${value ? 'translate-x-4' : 'translate-x-0.5'}`} />
                            </button>
                            <div className="flex-1">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    {t.label}
                                    {value ? null : (
                                        <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-300">
                                            OFF
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 text-xs text-ink-muted">
                                    {t.description}
                                </p>
                                {confirm === t.field && (
                                    <div className="mt-3 p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-sm">
                                        <div className="flex items-center gap-2 font-medium text-red-200">
                                            <ShieldOff className="w-4 h-4" />
                                            Confirm
                                        </div>
                                        <p className="mt-1 text-xs">
                                            This change is restrictive. Server-side
                                            lockout safeguards still apply (admins
                                            without an SSO identity will block the
                                            change with HTTP 409).
                                        </p>
                                        <div className="mt-2 flex gap-2">
                                            <button
                                                onClick={() => applyToggle(t.field, !value as never)}
                                                className="px-3 py-1.5 text-xs rounded bg-red-500 text-white"
                                            >
                                                Confirm change
                                            </button>
                                            <button
                                                onClick={() => setConfirm(null)}
                                                className="px-3 py-1.5 text-xs rounded border border-white/20"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}


// ── Lookup tab (user lookup + free-text search) ─────────────────────


function LookupTab() {
    const [query, setQuery] = useState('')
    const [structuredMode, setStructuredMode] = useState<
        'email' | 'attribute' | null
    >(null)
    const [attrKey, setAttrKey] = useState('staff_id')
    const [attrValue, setAttrValue] = useState('')
    const [results, setResults] = useState<UserSummary[]>([])
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    async function runSearch(e: React.FormEvent) {
        e.preventDefault()
        setError(null)
        setBusy(true)
        try {
            if (structuredMode === 'email') {
                const r = await ssoAdminService.lookupUserByEmail(query)
                setResults([r])
            } else if (structuredMode === 'attribute') {
                const r = await ssoAdminService.lookupUserByAttribute(
                    attrKey, attrValue,
                )
                setResults([r])
            } else {
                setResults(await ssoAdminService.searchUsers(query))
            }
        } catch (err) {
            setResults([])
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="space-y-4">
            <h2 className="text-base font-semibold">Find a user</h2>
            <p className="text-xs text-ink-muted">
                Free-text fan-out across email, names, identities, and indexed claim attributes. Use the structured modes for exact matches.
            </p>
            <form onSubmit={runSearch} className="space-y-3">
                <div className="flex gap-2">
                    <input
                        className="flex-1 px-3 py-2 rounded border border-white/10 bg-canvas text-sm"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={
                            structuredMode === 'email'
                                ? 'alice@corp.com'
                                : 'name, email, external_id, or attribute value…'
                        }
                    />
                    <button
                        type="submit"
                        disabled={busy}
                        className="px-4 py-2 rounded bg-accent-lineage text-white text-sm disabled:opacity-50"
                    >
                        <Search className="inline w-4 h-4 mr-1" />
                        Search
                    </button>
                </div>
                <details className="text-xs">
                    <summary className="cursor-pointer text-ink-muted">▸ Find by claim attribute (staff_id, employee_id, …)</summary>
                    <div className="mt-2 p-3 rounded-lg border border-white/10 bg-white/5 grid grid-cols-2 gap-3">
                        <label>
                            Key
                            <input
                                className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono"
                                value={attrKey}
                                onChange={(e) => setAttrKey(e.target.value)}
                            />
                        </label>
                        <label>
                            Value
                            <input
                                className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono"
                                value={attrValue}
                                onChange={(e) => setAttrValue(e.target.value)}
                            />
                        </label>
                        <div className="col-span-2 flex gap-2">
                            <button
                                type="button"
                                onClick={(e) => {
                                    setStructuredMode('attribute')
                                    runSearch(e as unknown as React.FormEvent)
                                }}
                                className="px-3 py-1.5 rounded border border-white/20 text-xs"
                            >
                                Run attribute lookup
                            </button>
                            <button
                                type="button"
                                onClick={() => setStructuredMode(null)}
                                className="text-xs text-ink-muted"
                            >
                                Back to free-text
                            </button>
                        </div>
                    </div>
                </details>
            </form>

            {error && <ErrorBanner message={error} />}

            {results.length > 0 && (
                <ul className="space-y-2">
                    {results.map((u) => (
                        <li
                            key={u.id}
                            className="p-4 rounded-xl border border-white/10 bg-white/5 text-sm space-y-2"
                        >
                            <div className="flex items-start justify-between">
                                <div>
                                    <div className="font-medium">
                                        {u.firstName} {u.lastName}{' '}
                                        <span className="text-ink-muted">
                                            ({u.email})
                                        </span>
                                    </div>
                                    <div className="text-xs text-ink-muted mt-0.5 font-mono">
                                        {u.id} · {u.status}
                                    </div>
                                </div>
                                <span
                                    className={
                                        'px-2 py-0.5 rounded-full text-xs ' + ({
                                            'local_signup': 'bg-blue-500/20 text-blue-300',
                                            'sso_jit': 'bg-violet-500/20 text-violet-300',
                                            'invite': 'bg-amber-500/20 text-amber-300',
                                            'admin_created': 'bg-zinc-500/20 text-zinc-300',
                                            'admin_linked': 'bg-teal-500/20 text-teal-300',
                                        }[u.signupSource] ?? 'bg-ink-muted/20')
                                    }
                                    title={
                                        u.signupProvider
                                            ? `via ${u.signupProvider.displayName}`
                                            : undefined
                                    }
                                >
                                    {u.signupSource}
                                    {u.signupProvider && (
                                        <>
                                            {' '}
                                            <span className="opacity-70">
                                                · {u.signupProvider.slug}
                                            </span>
                                        </>
                                    )}
                                </span>
                            </div>
                            {u.matchedOn && u.matchedOn.length > 0 && (
                                <div className="text-xs text-ink-muted">
                                    matched on: {u.matchedOn.join(', ')}
                                </div>
                            )}
                            {u.identities.length > 0 && (
                                <div>
                                    <div className="text-[11px] uppercase tracking-wider text-ink-muted mt-2">
                                        Linked identities
                                    </div>
                                    <ul className="mt-1 space-y-1 text-xs">
                                        {u.identities.map((i) => (
                                            <li key={i.id} className="font-mono">
                                                {i.provider.slug} · {i.externalId}
                                                {i.lastLoginAt && (
                                                    <span className="ml-2 text-ink-muted">
                                                        last login {new Date(i.lastLoginAt).toLocaleString()}
                                                    </span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {u.attributes.length > 0 && (
                                <div>
                                    <div className="text-[11px] uppercase tracking-wider text-ink-muted mt-2">
                                        Claim attributes
                                    </div>
                                    <ul className="mt-1 space-y-1 text-xs font-mono">
                                        {u.attributes.map((a) => (
                                            <li key={a.key}>
                                                {a.key} = {a.value}
                                                {a.sourceProvider && (
                                                    <span className="ml-2 text-ink-muted">
                                                        (from {a.sourceProvider.slug})
                                                    </span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}


export function AdminSso() {
    const [tab, setTab] = useState<Tab>('providers')
    return (
        <div className="max-w-5xl mx-auto p-8 space-y-6">
            <header>
                <h1 className="text-2xl font-semibold flex items-center gap-2">
                    <Beaker className="w-6 h-6 text-accent-lineage" />
                    SSO
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Configure Identity Providers, map IdP groups to internal roles or groups, manage organization-wide sign-in settings, and look up users by email or claim identifier.
                </p>
            </header>
            <nav className="flex gap-2 border-b border-white/10">
                {(['providers', 'mappings', 'settings', 'lookup'] as Tab[]).map((t) => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={
                            tab === t
                                ? 'px-4 py-2 text-sm font-medium border-b-2 border-accent-lineage text-ink flex items-center gap-1'
                                : 'px-4 py-2 text-sm text-ink-muted hover:text-ink flex items-center gap-1'
                        }
                    >
                        {t === 'providers' && <Power className="w-3.5 h-3.5" />}
                        {t === 'mappings' && <Plus className="w-3.5 h-3.5" />}
                        {t === 'settings' && <Settings className="w-3.5 h-3.5" />}
                        {t === 'lookup' && <Search className="w-3.5 h-3.5" />}
                        {t === 'providers' ? 'Providers'
                            : t === 'mappings' ? 'Group mappings'
                            : t === 'settings' ? 'Settings'
                            : 'Find user'}
                    </button>
                ))}
            </nav>
            {tab === 'providers' && <ProvidersTab />}
            {tab === 'mappings' && <MappingsTab />}
            {tab === 'settings' && <SettingsTab />}
            {tab === 'lookup' && <LookupTab />}
        </div>
    )
}

export default AdminSso
