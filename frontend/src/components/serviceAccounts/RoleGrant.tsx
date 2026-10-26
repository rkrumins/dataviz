/**
 * Giving a service account a workspace role: a workspace, found by name, then
 * a role in it that neither administers it nor lets people in.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { roleVisualFor } from '@/lib/roleVisual'
import { cn } from '@/lib/utils'
import { accessRequestsService, type RequestableRole } from '@/services/accessRequestsService'
import { workspaceService } from '@/services/workspaceService'

/** How many workspaces the picker offers at once; more are found by name. */
const WORKSPACES_SHOWN = 20

export function RoleGrant({ busy, onGrant }: { busy: boolean; onGrant: (workspaceId: string, role: string) => Promise<boolean> }) {
    const [find, setFind] = useState('')
    const search = useDebouncedValue(find.trim(), 250)
    const [found, setFound] = useState<{ items: { id: string; name: string }[]; total: number } | null>(null)
    const [workspace, setWorkspace] = useState<{ id: string; name: string } | null>(null)
    const workspaceId = workspace?.id ?? ''
    const [roles, setRoles] = useState<{ workspaceId: string; roles: RequestableRole[] } | null>(null)
    const [role, setRole] = useState('')

    useEffect(() => {
        let live = true
        workspaceService.listPage({ limit: WORKSPACES_SHOWN, search })
            .then((page) => {
                if (live) setFound({ items: page.items.map((w) => ({ id: w.id, name: w.name })), total: page.totalCount })
            })
            .catch(() => { if (live) setFound({ items: [], total: 0 }) })
        return () => { live = false }
    }, [search])
    // The chosen workspace stays on offer while another name is searched for.
    const offeredWorkspaces = workspace && !found?.items.some((w) => w.id === workspace.id)
        ? [workspace, ...(found?.items ?? [])]
        : found?.items ?? []
    useEffect(() => {
        if (!workspaceId) return
        let live = true
        accessRequestsService.requestableRoles(workspaceId)
            .then((options) => { if (live) setRoles({ workspaceId, roles: options.roles }) })
            .catch(() => { if (live) setRoles({ workspaceId, roles: [] }) })
        return () => { live = false }
    }, [workspaceId])

    const offered = useMemo(() => (roles?.workspaceId === workspaceId ? roles.roles : []), [roles, workspaceId])
    const select = 'h-9 px-2.5 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink outline-none focus:border-indigo-500'
    return (
        <div className="flex flex-wrap items-center gap-2">
            <input
                type="search"
                aria-label="Find a workspace"
                placeholder="Find a workspace"
                value={find}
                onChange={(e) => setFind(e.target.value)}
                className={cn(select, 'min-w-[9rem] flex-1')}
            />
            <select
                aria-label="Workspace"
                value={workspaceId}
                onChange={(e) => { setWorkspace(offeredWorkspaces.find((w) => w.id === e.target.value) ?? null); setRole('') }}
                className={cn(select, 'min-w-[10rem] flex-1')}
            >
                <option value="">
                    {found === null ? 'Loading workspaces…' : found.items.length ? 'Choose a workspace' : 'No workspace by that name'}
                </option>
                {offeredWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)} disabled={!workspaceId} className={cn(select, 'min-w-[9rem]')}>
                <option value="">Choose a role</option>
                {offered.map((r) => <option key={r.name} value={r.name}>{roleVisualFor(r.name).label}</option>)}
            </select>
            <Button
                variant="secondary"
                size="sm"
                leftIcon={Plus}
                disabled={busy || !workspaceId || !role}
                onClick={() => void onGrant(workspaceId, role).then((ok) => { if (ok) setRole('') })}
            >
                Give role
            </Button>
            {found && found.total > found.items.length && (
                <p className="w-full text-xs text-ink-muted">
                    Showing {found.items.length} of {found.total} workspaces — find others by name.
                </p>
            )}
        </div>
    )
}
