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
import { Trash2, Plus, Power, AlertCircle, Beaker } from 'lucide-react'

import {
    ssoAdminService,
    type IdpGroupMapping,
    type IdpProvider,
} from '@/services/ssoAdminService'

type Tab = 'providers' | 'mappings'


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
            const [m, p] = await Promise.all([
                ssoAdminService.listGroupMappings(),
                ssoAdminService.listProviders(),
            ])
            setRows(m)
            setProviders(p)
            setError(null)
        } catch (err) {
            setError((err as Error).message)
        }
    }, [])

    useEffect(() => { void refresh() }, [refresh])

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
                                Role name
                                <input
                                    className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono text-xs"
                                    value={roleName}
                                    onChange={(e) => setRoleName(e.target.value)}
                                    placeholder="user"
                                    required
                                />
                            </label>
                            <label className="text-xs">
                                Scope
                                <select
                                    className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 text-xs"
                                    value={scopeType}
                                    onChange={(e) => setScopeType(e.target.value as 'global' | 'workspace')}
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
                                {m.targetType === 'role_binding'
                                    ? `role ${m.roleName} @ ${m.scopeType}${m.scopeId ? `/${m.scopeId}` : ''}`
                                    : `group ${m.targetGroupId}`}
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
                    Configure Identity Providers and map IdP groups to internal roles or groups.
                </p>
            </header>
            <nav className="flex gap-2 border-b border-white/10">
                {(['providers', 'mappings'] as Tab[]).map((t) => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={
                            tab === t
                                ? 'px-4 py-2 text-sm font-medium border-b-2 border-accent-lineage text-ink'
                                : 'px-4 py-2 text-sm text-ink-muted hover:text-ink'
                        }
                    >
                        {t === 'providers' ? 'Providers' : 'Group mappings'}
                    </button>
                ))}
            </nav>
            {tab === 'providers' ? <ProvidersTab /> : <MappingsTab />}
        </div>
    )
}

export default AdminSso
