/**
 * Asking a workspace for access for a service account you manage: a
 * workspace — one you are in, or one Find a workspace lists — then a role
 * that may be asked for there, and why. The workspace's admins and stewards
 * answer it as they answer a person's request, seeing the account and its
 * managers; a workspace that takes no requests is asked to add it instead.
 */
import { useEffect, useMemo, useState } from 'react'
import { Send } from 'lucide-react'

import { KeyDialog } from '@/components/apiKeys/KeyDialog'
import { Button } from '@/components/ui/Button'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { roleVisualFor } from '@/lib/roleVisual'
import { cn } from '@/lib/utils'
import { accessRequestsService, type RequestOptions } from '@/services/accessRequestsService'
import type { ServiceAccountDetail } from '@/services/serviceAccountService'
import { workspaceService } from '@/services/workspaceService'

/** How many workspaces the picker offers at once; more are found by name. */
const WORKSPACES_SHOWN = 20

type Place = { id: string; name: string }

export function RequestForAccount({ account, onClose, onSent }: {
    account: ServiceAccountDetail
    onClose: () => void
    /** Asked: the account should be read again. */
    onSent: () => void
}) {
    const { notify } = useAppNotifications()
    const [find, setFind] = useState('')
    const search = useDebouncedValue(find.trim(), 250)
    const [mine, setMine] = useState<Place[] | null>(null)
    // Find a workspace, while the deployment has it on: workspaces you are
    // not in yet. Read once; filtered here.
    const [listed, setListed] = useState<Place[]>([])
    const [workspace, setWorkspace] = useState<Place | null>(null)
    const [options, setOptions] = useState<{ workspaceId: string; options: RequestOptions | null } | null>(null)
    const [role, setRole] = useState('')
    const [why, setWhy] = useState('')
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        let live = true
        workspaceService.listPage({ limit: WORKSPACES_SHOWN, search })
            .then((page) => { if (live) setMine(page.items.map((w) => ({ id: w.id, name: w.name }))) })
            .catch(() => { if (live) setMine([]) })
        return () => { live = false }
    }, [search])
    useEffect(() => {
        let live = true
        workspaceService.directory()
            .then((entries) => { if (live) setListed(entries.map((e) => ({ id: e.id, name: e.name }))) })
            .catch(() => { /* Find a workspace is switched off: your own workspaces only. */ })
        return () => { live = false }
    }, [])

    const offered = useMemo(() => {
        const q = search.toLowerCase()
        const seen = new Map<string, Place>()
        for (const w of [...(workspace ? [workspace] : []), ...(mine ?? []), ...listed.filter((w) => w.name.toLowerCase().includes(q))]) {
            if (!seen.has(w.id)) seen.set(w.id, w)
        }
        return [...seen.values()]
    }, [workspace, mine, listed, search])

    const workspaceId = workspace?.id ?? ''
    useEffect(() => {
        if (!workspaceId) return
        let live = true
        accessRequestsService.requestableRoles(workspaceId)
            .then((found) => { if (live) setOptions({ workspaceId, options: found }) })
            .catch(() => { if (live) setOptions({ workspaceId, options: null }) })
        return () => { live = false }
    }, [workspaceId])

    const current = options?.workspaceId === workspaceId ? options.options : null
    const held = new Set(account.roles.filter((r) => r.workspaceId === workspaceId).map((r) => r.role))
    const roles = (current?.roles ?? []).filter((r) => !held.has(r.name))
    const closed = current?.requestPolicy === 'closed'

    async function ask() {
        setBusy(true)
        try {
            await accessRequestsService.submit({
                targetType: 'workspace', targetId: workspaceId, requestedRole: role,
                justification: why.trim() || null, serviceAccountId: account.id,
            })
            notify('success', `Asked ${workspace?.name ?? 'the workspace'} for ${roleVisualFor(role).label} for “${account.name}”`)
            onSent()
        } catch (err) {
            notify('error', err instanceof Error ? err.message : 'The request could not be sent.')
            setBusy(false)
        }
    }

    const field = 'h-9 px-2.5 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink outline-none focus:border-indigo-500'
    return (
        <KeyDialog
            icon={Send}
            title={`Ask for access for “${account.name}”`}
            subtitle="The workspace’s admins answer, seeing the account and who manages it."
            onClose={onClose}
            footer={(
                <>
                    <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
                    <Button
                        variant="primary"
                        size="sm"
                        leftIcon={Send}
                        disabled={!workspaceId || !role || closed}
                        loading={busy}
                        onClick={() => void ask()}
                    >
                        Ask
                    </Button>
                </>
            )}
        >
            <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                    <input
                        type="search"
                        aria-label="Find a workspace"
                        placeholder="Find a workspace"
                        value={find}
                        onChange={(e) => setFind(e.target.value)}
                        className={cn(field, 'min-w-[9rem] flex-1')}
                    />
                    <select
                        aria-label="Workspace"
                        value={workspaceId}
                        onChange={(e) => { setWorkspace(offered.find((w) => w.id === e.target.value) ?? null); setRole('') }}
                        className={cn(field, 'min-w-[10rem] flex-1')}
                    >
                        <option value="">
                            {mine === null ? 'Loading workspaces…' : offered.length ? 'Choose a workspace' : 'No workspace by that name'}
                        </option>
                        {offered.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                </div>
                {closed ? (
                    <p role="status" className="text-sm text-ink-muted">
                        This workspace isn’t taking requests: ask its admins to add “{account.name}”.
                    </p>
                ) : (
                    <select
                        aria-label="Role"
                        value={role}
                        onChange={(e) => setRole(e.target.value)}
                        disabled={!workspaceId}
                        className={cn(field, 'w-full')}
                    >
                        <option value="">{workspaceId && current && roles.length === 0 ? 'Nothing more to ask for' : 'Choose a role'}</option>
                        {roles.map((r) => <option key={r.name} value={r.name}>{roleVisualFor(r.name).label}</option>)}
                    </select>
                )}
                <textarea
                    aria-label="Why it needs this"
                    placeholder="Why it needs this (optional)"
                    value={why}
                    maxLength={1000}
                    rows={2}
                    onChange={(e) => setWhy(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink outline-none focus:border-indigo-500 resize-none"
                />
            </div>
        </KeyDialog>
    )
}
