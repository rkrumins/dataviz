/**
 * Create or rotate an API key, confirm it's you, and see the token once.
 *
 * Three phases in one dialog: the form, confirming it's you (step-up), and
 * the reveal. The reveal is the one screen that cannot be come back to — the
 * token exists nowhere else — so it is the only phase without a quiet way out:
 * closing it means you have copied the key.
 *
 * Confirming with an identity provider leaves the page. What was filled in is
 * parked first (`apiKeyDraft`) and the page reopens this dialog with it when
 * the provider sends you back.
 *
 * The page mounts a fresh dialog for each opening (a new `key`), so the form
 * starts from its props rather than being reset after the fact.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
    AlertTriangle, Check, Copy, Database, Eye, KeySquare, LayoutGrid, Search, ShieldCheck, X,
} from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { useModalA11y } from '@/hooks/useModalA11y'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import {
    ApiKeyError,
    apiKeyService,
    type ApiKey,
    type ApiKeyOptions,
    type ApiKeyPermissions,
    type CreatedApiKey,
    type Level,
    type PickerItem,
} from '@/services/apiKeyService'
import {
    curlExample,
    describePermissions,
    describeResources,
    expiryFields,
    expiryOptions,
    overreach,
    parseCidrs,
} from './apiKeyFormat'
import {
    freshDraft, parkDraft, type ApiKeyDraft, type Grace, type ResourceMode,
} from './apiKeyDraft'

const LEVELS: { value: Level; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'read', label: 'Read' },
    { value: 'write', label: 'Read & write' },
]

const GRACE: { value: string; label: string }[] = [
    { value: '0', label: 'Stop it now' },
    { value: '3600', label: 'In 1 hour' },
    { value: '86400', label: 'In 1 day' },
    { value: '604800', label: 'In 7 days' },
]

export function ApiKeyDialog({
    open, options, rotating, draft: resumed, onClose, onChanged,
}: {
    open: boolean
    options: ApiKeyOptions | null
    /** Set to rotate this key; absent to create one. */
    rotating?: ApiKey
    /** A draft parked before an identity-provider sign-in. */
    draft?: ApiKeyDraft | null
    onClose: () => void
    /** A key was created, rotated or revoked: the list should reload. */
    onChanged: () => void
}) {
    const [draft, setDraft] = useState<ApiKeyDraft>(() => resumed ?? freshDraft(options, rotating))
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [ssoLogin, setSsoLogin] = useState<string | null>(null)
    const [created, setCreated] = useState<CreatedApiKey | null>(null)

    const close = useCallback(() => {
        if (busy) return
        if (created) onChanged()
        onClose()
    }, [busy, created, onChanged, onClose])

    const panelRef = useModalA11y(open, close)
    const update = (patch: Partial<ApiKeyDraft>) => setDraft((d) => ({ ...d, ...patch }))

    const policy = options?.policy
    const needsPassword = options?.stepUp.method === 'password'
    const isRotate = draft.mode === 'rotate'

    const warnings = useMemo(
        () => (draft.resourceMode === 'items'
            ? overreach(draft.permissions, draft.views, draft.dataSources)
            : []),
        [draft],
    )

    function resources() {
        if (draft.resourceMode === 'all') return 'all' as const
        if (draft.resourceMode === 'workspaces') {
            return { workspaces: draft.workspaces, views: [], dataSources: [] }
        }
        return {
            workspaces: [],
            views: draft.views.map((v) => v.id),
            dataSources: draft.dataSources.map((d) => d.id),
        }
    }

    async function submit() {
        setBusy(true)
        setError(null)
        try {
            const expiry = draft.expiry === 'same' ? {} : expiryFields(draft.expiry, draft.customDate)
            const result = isRotate && draft.keyId
                ? await apiKeyService.rotate(draft.keyId, {
                    graceSeconds: draft.grace,
                    ...expiry,
                    currentPassword: needsPassword ? password : undefined,
                })
                : await apiKeyService.create({
                    name: draft.name.trim(),
                    description: draft.description.trim() || undefined,
                    permissions: draft.permissions,
                    resources: resources(),
                    allowedCidrs: parseCidrs(draft.cidrs),
                    ...expiry,
                    currentPassword: needsPassword ? password : undefined,
                })
            setPassword('')
            setCreated(result)
        } catch (err) {
            if (err instanceof ApiKeyError && err.code === 'step_up_required' && err.method === 'sso' && err.loginUrl) {
                setSsoLogin(err.loginUrl)
            } else {
                setError(err instanceof Error ? err.message : 'The key could not be created.')
            }
        } finally {
            setBusy(false)
        }
    }

    function confirmWithProvider() {
        if (!ssoLogin) return
        parkDraft(draft)
        window.location.href = ssoLogin
    }

    const canSubmit = !busy && (isRotate || (
        draft.name.trim().length > 0
        && (draft.permissions.views !== 'none' || draft.permissions.data !== 'none')
        && (draft.resourceMode !== 'workspaces' || draft.workspaces.length > 0)
        && (draft.resourceMode !== 'items' || draft.views.length + draft.dataSources.length > 0)
        && (draft.expiry !== 'custom' || Boolean(draft.customDate))
    )) && (!needsPassword || password.length > 0)

    if (!open) return null

    return createPortal(
        <>
            <Backdrop open onClick={created ? undefined : close} zClassName="z-[80]" className="bg-black/60" />
            <div className="fixed inset-0 z-[81] flex items-center justify-center p-4 pointer-events-none">
                <motion.div
                    ref={panelRef}
                    tabIndex={-1}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="api-key-dialog-title"
                    initial={{ scale: 0.97, opacity: 0, y: 8 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    transition={MOTION.modalSpring}
                    className="pointer-events-auto w-full max-w-2xl max-h-[88vh] flex flex-col bg-canvas rounded-2xl shadow-2xl shadow-black/30 border border-glass-border overflow-hidden outline-none"
                >
                    <header className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-glass-border shrink-0">
                        <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center shrink-0">
                            <KeySquare className="w-5 h-5 text-indigo-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 id="api-key-dialog-title" className="text-base font-bold text-ink">
                                {created
                                    ? 'Copy your new key'
                                    : isRotate ? `Rotate “${rotating?.name ?? 'key'}”` : 'Create an API key'}
                            </h2>
                            <p className="text-xs text-ink-muted">
                                {created
                                    ? 'This is the only time it will be shown.'
                                    : isRotate
                                        ? 'A new token that can do exactly what this one does.'
                                        : 'It acts as you — never more than you can do yourself.'}
                            </p>
                        </div>
                        {!created && (
                            <button type="button" onClick={close} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </header>

                    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-6">
                        {created ? (
                            <Reveal created={created} />
                        ) : ssoLogin ? (
                            <ConfirmWithProvider onConfirm={confirmWithProvider} />
                        ) : (
                            <>
                                {!isRotate && (
                                    <CreateFields
                                        draft={draft}
                                        update={update}
                                        options={options}
                                        warnings={warnings}
                                    />
                                )}
                                {isRotate && (
                                    <Field label="When should the old key stop working?" hint="Keep it a little while if something still uses it.">
                                        <Segmented
                                            label="Old key keeps working"
                                            options={GRACE}
                                            value={String(draft.grace)}
                                            onChange={(v) => update({ grace: Number(v) as Grace })}
                                        />
                                    </Field>
                                )}
                                <Field label="Expires" hint={policy?.maxLifetimeDays ? `Keys here last at most ${policy.maxLifetimeDays} days.` : undefined}>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <select
                                            aria-label="Expires"
                                            value={draft.expiry}
                                            onChange={(e) => update({ expiry: e.target.value as ApiKeyDraft['expiry'] })}
                                            className="h-9 px-3 rounded-xl border border-glass-border bg-canvas-elevated text-sm text-ink"
                                        >
                                            {isRotate && <option value="same">Same length as before</option>}
                                            {expiryOptions(policy?.maxLifetimeDays ?? null).map((o) => (
                                                <option key={o.value} value={o.value}>{o.label}</option>
                                            ))}
                                        </select>
                                        {draft.expiry === 'custom' && (
                                            <input
                                                type="date"
                                                aria-label="Expiry date"
                                                value={draft.customDate}
                                                onChange={(e) => update({ customDate: e.target.value })}
                                                className="h-9 px-3 rounded-xl border border-glass-border bg-canvas-elevated text-sm text-ink"
                                            />
                                        )}
                                        {draft.expiry === 'never' && (
                                            <span className="text-xs text-amber-600 dark:text-amber-400">
                                                A key that never expires keeps working until someone revokes it.
                                            </span>
                                        )}
                                    </div>
                                </Field>
                                {needsPassword && (
                                    <Field label="Confirm it’s you" hint="Your password, to make sure it is you creating a credential.">
                                        <input
                                            type="password"
                                            autoComplete="current-password"
                                            aria-label="Your password"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            className="w-full h-9 px-3 rounded-xl border border-glass-border bg-canvas-elevated text-sm text-ink"
                                        />
                                    </Field>
                                )}
                                {error && (
                                    <p role="alert" className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-600 dark:text-red-400">
                                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                                        {error}
                                    </p>
                                )}
                            </>
                        )}
                    </div>

                    <footer className="flex items-center justify-end gap-2 px-6 py-4 border-t border-glass-border shrink-0">
                        {created ? (
                            <Button variant="primary" onClick={close} leftIcon={Check}>
                                I’ve copied it
                            </Button>
                        ) : ssoLogin ? (
                            <Button variant="secondary" onClick={close}>Cancel</Button>
                        ) : (
                            <>
                                <Button variant="secondary" onClick={close}>Cancel</Button>
                                <Button variant="primary" onClick={submit} loading={busy} disabled={!canSubmit}>
                                    {isRotate ? 'Rotate key' : 'Create key'}
                                </Button>
                            </>
                        )}
                    </footer>
                </motion.div>
            </div>
        </>,
        document.body,
    )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div>
            <p className="text-xs font-semibold text-ink mb-1.5">{label}</p>
            {children}
            {hint && <p className="mt-1.5 text-[11px] text-ink-muted">{hint}</p>}
        </div>
    )
}

function CreateFields({
    draft, update, options, warnings,
}: {
    draft: ApiKeyDraft
    update: (patch: Partial<ApiKeyDraft>) => void
    options: ApiKeyOptions | null
    warnings: PickerItem[]
}) {
    const p = draft.permissions
    const setPermissions = (patch: Partial<ApiKeyPermissions>) => {
        const next = { ...p, ...patch }
        if (next.views !== 'write') next.publish = false
        update({ permissions: next })
    }
    return (
        <>
            <Field label="Name" hint="Something that says where it is used, like “nightly lineage sync”.">
                <input
                    aria-label="Name"
                    value={draft.name}
                    maxLength={80}
                    onChange={(e) => update({ name: e.target.value })}
                    className="w-full h-9 px-3 rounded-xl border border-glass-border bg-canvas-elevated text-sm text-ink"
                />
            </Field>

            <Field label="What it can reach">
                <Segmented
                    label="What it can reach"
                    options={[
                        { value: 'items', label: 'Selected views & data sources', icon: Eye },
                        { value: 'workspaces', label: 'Selected workspaces', icon: LayoutGrid },
                        { value: 'all', label: 'Everything I can access' },
                    ]}
                    value={draft.resourceMode}
                    onChange={(v) => update({ resourceMode: v as ResourceMode })}
                />
                <div className="mt-3">
                    {draft.resourceMode === 'all' && (
                        <p className="text-xs text-ink-muted">
                            Every workspace, view and data source you can reach — now and later, as your access changes.
                        </p>
                    )}
                    {draft.resourceMode === 'workspaces' && (
                        <WorkspacePicker
                            workspaces={options?.workspaces ?? []}
                            selected={draft.workspaces}
                            onChange={(workspaces) => update({ workspaces })}
                        />
                    )}
                    {draft.resourceMode === 'items' && (
                        <div className="grid gap-3 sm:grid-cols-2">
                            <ResourcePicker
                                type="view"
                                label="Views"
                                icon={Eye}
                                selected={draft.views}
                                onChange={(views) => update({ views })}
                            />
                            <ResourcePicker
                                type="data_source"
                                label="Data sources"
                                icon={Database}
                                selected={draft.dataSources}
                                onChange={(dataSources) => update({ dataSources })}
                            />
                        </div>
                    )}
                </div>
            </Field>

            <Field label="What it can do there">
                <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-ink">Views</span>
                        <Segmented label="Views" options={LEVELS} value={p.views} onChange={(views) => setPermissions({ views })} />
                    </div>
                    <label className={cn('flex items-center justify-between gap-3 text-sm', p.views !== 'write' && 'opacity-50')}>
                        <span className="text-ink">Publish views to everyone</span>
                        <input
                            type="checkbox"
                            checked={p.publish}
                            disabled={p.views !== 'write'}
                            onChange={(e) => setPermissions({ publish: e.target.checked })}
                        />
                    </label>
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-ink">Data</span>
                        <Segmented label="Data" options={LEVELS} value={p.data} onChange={(data) => setPermissions({ data })} />
                    </div>
                </div>
                {warnings.length > 0 && (
                    <p className="mt-3 flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>
                            You can only read {warnings.map((w) => `“${w.name}”`).join(', ')} — the key will
                            only read {warnings.length === 1 ? 'it' : 'them'} too. A key never reaches past you.
                        </span>
                    </p>
                )}
                <p className="mt-3 text-[11px] text-ink-muted">
                    {describePermissions(p)} on {describeResources(
                        draft.resourceMode === 'all' ? 'all' : {
                            workspaces: draft.resourceMode === 'workspaces' ? draft.workspaces : [],
                            views: draft.resourceMode === 'items' ? draft.views.map((v) => v.id) : [],
                            dataSources: draft.resourceMode === 'items' ? draft.dataSources.map((d) => d.id) : [],
                        },
                    ).toLowerCase()}.
                </p>
            </Field>

            <Field label="Only from these networks (optional)" hint="Addresses or ranges such as 203.0.113.0/24, one per line. Leave empty to allow any.">
                <textarea
                    aria-label="Allowed networks"
                    rows={2}
                    value={draft.cidrs}
                    onChange={(e) => update({ cidrs: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-glass-border bg-canvas-elevated text-sm font-mono text-ink"
                />
            </Field>
        </>
    )
}

function WorkspacePicker({
    workspaces, selected, onChange,
}: {
    workspaces: ApiKeyOptions['workspaces']
    selected: string[]
    onChange: (ids: string[]) => void
}) {
    if (workspaces.length === 0) {
        return <p className="text-xs text-ink-muted">You are not a member of any workspace.</p>
    }
    return (
        <ul className="max-h-48 overflow-y-auto rounded-xl border border-glass-border divide-y divide-glass-border">
            {workspaces.map((w) => {
                const on = selected.includes(w.id)
                return (
                    <li key={w.id}>
                        <label className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer">
                            <input
                                type="checkbox"
                                checked={on}
                                onChange={() => onChange(on ? selected.filter((x) => x !== w.id) : [...selected, w.id])}
                            />
                            <span className="flex-1 min-w-0 truncate text-ink">{w.name}</span>
                            <span className="text-[11px] text-ink-muted">
                                views {w.views}, data {w.data}
                            </span>
                        </label>
                    </li>
                )
            })}
        </ul>
    )
}

function ResourcePicker({
    type, label, icon: Icon, selected, onChange,
}: {
    type: 'view' | 'data_source'
    label: string
    icon: typeof Eye
    selected: PickerItem[]
    onChange: (items: PickerItem[]) => void
}) {
    const [q, setQ] = useState('')
    const [results, setResults] = useState<PickerItem[]>([])
    useEffect(() => {
        let cancelled = false
        const handle = setTimeout(() => {
            apiKeyService.searchResources(type, q)
                .then((items) => { if (!cancelled) setResults(items) })
                .catch(() => { if (!cancelled) setResults([]) })
        }, 200)
        return () => { cancelled = true; clearTimeout(handle) }
    }, [type, q])

    const chosen = new Set(selected.map((s) => s.id))
    return (
        <div className="rounded-xl border border-glass-border p-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-2">
                <Icon className="w-3.5 h-3.5" /> {label}
            </p>
            {selected.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                    {selected.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            onClick={() => onChange(selected.filter((x) => x.id !== s.id))}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
                            aria-label={`Remove ${s.name}`}
                        >
                            {s.name}
                            <X className="w-3 h-3" />
                        </button>
                    ))}
                </div>
            )}
            <div className="relative">
                <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-ink-muted" />
                <input
                    aria-label={`Search ${label.toLowerCase()}`}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search"
                    className="w-full h-8 pl-8 pr-2 rounded-lg border border-glass-border bg-canvas-elevated text-xs text-ink"
                />
            </div>
            <ul className="mt-1.5 max-h-36 overflow-y-auto">
                {results.filter((r) => !chosen.has(r.id)).map((r) => (
                    <li key={r.id}>
                        <button
                            type="button"
                            onClick={() => onChange([...selected, r])}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                        >
                            <span className="flex-1 min-w-0 truncate text-ink">{r.name}</span>
                            <span className="text-ink-muted truncate max-w-[40%]">{r.workspaceName}</span>
                            <span className={cn('text-[10px] font-semibold', r.level === 'write' ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-muted')}>
                                {r.level === 'write' ? 'you edit' : 'you read'}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    )
}

function ConfirmWithProvider({ onConfirm }: { onConfirm: () => void }) {
    return (
        <div className="flex flex-col items-center text-center py-6">
            <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 flex items-center justify-center mb-3">
                <ShieldCheck className="w-6 h-6 text-indigo-500" />
            </div>
            <p className="text-sm font-semibold text-ink">Confirm it’s you</p>
            <p className="mt-1 text-xs text-ink-muted max-w-sm">
                A key is a credential that outlives this session, so it needs a fresh sign-in with
                your identity provider. You’ll come back here with everything you filled in.
            </p>
            <Button className="mt-4" variant="primary" onClick={onConfirm} leftIcon={ShieldCheck}>
                Sign in again to continue
            </Button>
        </div>
    )
}

function Reveal({ created }: { created: CreatedApiKey }) {
    const [copied, setCopied] = useState<'token' | 'curl' | null>(null)
    const copy = async (text: string, what: 'token' | 'curl') => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(what)
            setTimeout(() => setCopied(null), 2000)
        } catch {
            // Clipboard refused (permissions): the field is selectable.
        }
    }
    const curl = curlExample(created.token, window.location.origin)
    return (
        <div className="space-y-4">
            <p className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Copy it now and keep it somewhere safe, like a secrets manager. It is not stored
                anywhere you can see it again — if it is lost, rotate the key.
            </p>
            <div className="flex items-center gap-2 rounded-2xl border-2 border-emerald-500/40 bg-emerald-500/[0.05] p-2 pl-4">
                <input
                    readOnly
                    value={created.token}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Your new API key"
                    className="flex-1 min-w-0 bg-transparent font-mono text-sm text-ink outline-none"
                />
                <Button variant="primary" onClick={() => copy(created.token, 'token')} leftIcon={copied === 'token' ? Check : Copy}>
                    {copied === 'token' ? 'Copied' : 'Copy'}
                </Button>
            </div>
            <div>
                <p className="text-xs font-semibold text-ink mb-1.5">Check that it works</p>
                <div className="flex items-start gap-2 rounded-xl bg-black/[0.04] dark:bg-white/[0.05] p-3">
                    <code className="flex-1 min-w-0 break-all font-mono text-[11px] text-ink-secondary">{curl}</code>
                    <button type="button" onClick={() => copy(curl, 'curl')} aria-label="Copy the command" className="text-ink-muted hover:text-ink">
                        {copied === 'curl' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                </div>
            </div>
            <p className="text-[11px] text-ink-muted">
                {describePermissions(created.key.permissions)} on {describeResources(created.key.resources).toLowerCase()}.
                {created.key.expiresAt
                    ? ` Expires ${new Date(created.key.expiresAt).toLocaleDateString()}.`
                    : ' Never expires.'}
            </p>
        </div>
    )
}
