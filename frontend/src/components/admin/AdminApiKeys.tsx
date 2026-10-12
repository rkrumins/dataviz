/**
 * AdminApiKeys — every API key on the platform, and who it acts as.
 *
 * For the questions an administrator brings to a credential inventory: whose
 * keys are these, what can they reach, which ones nobody has used in months,
 * and how do I stop one — or all of one person's — now. Ending a person's
 * sessions does not touch their keys, which is why "Revoke all their keys"
 * sits beside every owner here.
 *
 * Auditors (`system:audit:read`) see the inventory; revoking needs
 * `system:users:manage`, as the server enforces.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, KeySquare, RefreshCw, Search, Trash2, UserX } from 'lucide-react'

import { STATUS_LABEL, describePermissions, describeResources } from '@/components/apiKeys/apiKeyFormat'
import { PageContainer } from '@/components/layout/PageContainer'
import { Button } from '@/components/ui/Button'
import { TablePagination } from '@/components/ui/TablePagination'
import { TimeStamp } from '@/components/ui/TimeStamp'
import { useAppNotifications } from '@/components/ui/notifications'
import { cn } from '@/lib/utils'
import { apiKeyService, type AdminApiKey } from '@/services/apiKeyService'
import { usePermission } from '@/store/auth'

const PAGE_SIZE = 50

type StatusFilter = '' | 'active' | 'expired' | 'revoked'

export function AdminApiKeys() {
    const { notify } = useAppNotifications()
    const canRevoke = usePermission('system:users:manage')
    const [items, setItems] = useState<AdminApiKey[]>([])
    const [total, setTotal] = useState(0)
    const [page, setPage] = useState(1)
    const [q, setQ] = useState('')
    const [status, setStatus] = useState<StatusFilter>('active')
    const [unused, setUnused] = useState(false)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [confirming, setConfirming] = useState<string | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await apiKeyService.adminList({
                q: q.trim() || undefined,
                status: status || undefined,
                unusedDays: unused ? 90 : undefined,
                limit: PAGE_SIZE,
                offset: (page - 1) * PAGE_SIZE,
            })
            setItems(res.items)
            setTotal(res.total)
            setError(null)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setLoading(false)
        }
    }, [q, status, unused, page])

    useEffect(() => {
        const handle = setTimeout(() => void load(), 250)
        return () => clearTimeout(handle)
    }, [load])

    async function revoke(key: AdminApiKey) {
        setConfirming(null)
        try {
            await apiKeyService.adminRevoke(key.id)
            notify('success', `“${key.name}” revoked. Its owner has been told.`)
            await load()
        } catch (err) {
            notify('error', (err as Error).message)
        }
    }

    async function revokeAll(owner: AdminApiKey['owner']) {
        setConfirming(null)
        try {
            const { revoked } = await apiKeyService.adminRevokeAll(owner.id)
            notify('success', `${revoked} key${revoked === 1 ? '' : 's'} of ${owner.displayName} revoked.`)
            await load()
        } catch (err) {
            notify('error', (err as Error).message)
        }
    }

    return (
        <PageContainer gutter="shell" className="py-8 space-y-6">
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md shrink-0">
                        <KeySquare className="w-6 h-6 text-white" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-bold text-ink">API keys</h1>
                        <p className="text-sm text-ink-muted">
                            Every key, who it acts as, what it can reach, and when it was last used.
                        </p>
                    </div>
                </div>
                <Button variant="secondary" size="sm" leftIcon={RefreshCw} onClick={() => void load()} loading={loading}>
                    Refresh
                </Button>
            </div>

            <div className="rounded-xl border border-glass-border bg-canvas-elevated p-3 flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[220px]">
                    <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-ink-muted" />
                    <input
                        aria-label="Search keys"
                        value={q}
                        onChange={(e) => { setQ(e.target.value); setPage(1) }}
                        placeholder="Key name, prefix or owner email"
                        className="w-full h-8 pl-8 pr-2 rounded-lg border border-glass-border bg-canvas text-xs text-ink"
                    />
                </div>
                <select
                    aria-label="Status"
                    value={status}
                    onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(1) }}
                    className="h-8 px-2 rounded-lg border border-glass-border bg-canvas text-xs text-ink"
                >
                    <option value="active">Active</option>
                    <option value="expired">Expired</option>
                    <option value="revoked">Revoked</option>
                    <option value="">Any status</option>
                </select>
                <label className="inline-flex items-center gap-2 text-xs text-ink-secondary">
                    <input type="checkbox" checked={unused} onChange={(e) => { setUnused(e.target.checked); setPage(1) }} />
                    Unused for 90 days
                </label>
                <span className="ml-auto text-xs text-ink-muted">{total} key{total === 1 ? '' : 's'}</span>
            </div>

            {error && (
                <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            <div className="rounded-xl border border-glass-border bg-canvas-elevated overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="text-left text-ink-muted border-b border-glass-border">
                            <th className="font-medium px-3 py-2">Key</th>
                            <th className="font-medium px-3 py-2">Owner</th>
                            <th className="font-medium px-3 py-2">Can do</th>
                            <th className="font-medium px-3 py-2">Last used</th>
                            <th className="font-medium px-3 py-2">Expires</th>
                            <th className="font-medium px-3 py-2 sr-only">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items.length === 0 && !loading && (
                            <tr><td colSpan={6} className="px-3 py-8 text-center text-ink-muted">No keys match.</td></tr>
                        )}
                        {items.map((key) => (
                            <tr key={key.id} className="border-b border-glass-border last:border-0 align-top">
                                <td className="px-3 py-2.5">
                                    <p className="font-semibold text-ink">{key.name}</p>
                                    <p className="font-mono text-ink-muted">{key.prefix}…</p>
                                    <p className={cn('mt-0.5', key.status === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-muted')}>
                                        {STATUS_LABEL[key.status] ?? key.status}
                                    </p>
                                </td>
                                <td className="px-3 py-2.5">
                                    <p className="text-ink">{key.owner.displayName}</p>
                                    <p className="text-ink-muted">{key.owner.email}</p>
                                </td>
                                <td className="px-3 py-2.5 text-ink-secondary">
                                    <p>{describePermissions(key.permissions)}</p>
                                    <p className="text-ink-muted">{describeResources(key.resources)}</p>
                                    {key.allowedCidrs.length > 0 && <p className="text-ink-muted">Only from {key.allowedCidrs.join(', ')}</p>}
                                </td>
                                <td className="px-3 py-2.5">
                                    {key.lastUsedAt
                                        ? <TimeStamp at={key.lastUsedAt} icon={null} tooltipLines={[key.lastUsedIp && `From ${key.lastUsedIp}`, key.lastUsedUserAgent]} />
                                        : <span className="text-ink-muted">Never</span>}
                                    {key.lastUsedIp && <p className="text-ink-muted">{key.lastUsedIp}</p>}
                                </td>
                                <td className="px-3 py-2.5 text-ink-secondary">
                                    {key.revokedAt
                                        ? `Revoked ${new Date(key.revokedAt).toLocaleDateString()}`
                                        : key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : 'Never'}
                                </td>
                                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                                    {canRevoke && !key.revokedAt && (
                                        confirming === key.id ? (
                                            <span className="inline-flex items-center gap-1.5">
                                                <Button variant="danger" size="sm" onClick={() => revoke(key)}>Revoke</Button>
                                                <Button variant="danger" size="sm" leftIcon={UserX} onClick={() => revokeAll(key.owner)}>
                                                    All of theirs
                                                </Button>
                                                <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>Keep</Button>
                                            </span>
                                        ) : (
                                            <Button variant="ghost" size="sm" leftIcon={Trash2} onClick={() => setConfirming(key.id)}>
                                                Revoke…
                                            </Button>
                                        )
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <TablePagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </PageContainer>
    )
}
