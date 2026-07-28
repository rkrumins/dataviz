/**
 * MappingsTab — turning your org chart into access here.
 *
 * Two columns, because the page is 1760px wide and this content is not.
 * The main column carries the work — compose a rule, read the rules that
 * exist. The rail carries the reference material: the reconciliation
 * contract and the privileged-role floor, both read once and then never
 * again, and both previously eating the top of the page above the thing
 * the operator came to do.
 *
 * The contract itself is the reason this feature exists and the original
 * page never stated it: these rules are re-evaluated on every sign-in and
 * every session refresh, so the directory stays the source of truth.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, ShieldAlert, Sparkles, Waypoints } from 'lucide-react'

import {
    ssoAdminService,
    type IdpGroupMapping,
    type IdpProvider,
} from '@/services/ssoAdminService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { SsoCard, SsoEmpty, SsoSectionLabel } from '../ui/SsoCard'
import { ErrorBanner } from './ErrorBanner'
import { MappingComposer } from './mappings/MappingComposer'
import { MappingGroupCard, groupMappings } from './mappings/MappingGroupCard'

export function MappingsTab({ onChanged }: { onChanged?: () => void }) {
    const [rows, setRows] = useState<IdpGroupMapping[]>([])
    const [providers, setProviders] = useState<IdpProvider[]>([])
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([])
    const [groups, setGroups] = useState<GroupResponse[]>([])
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [loaded, setLoaded] = useState(false)

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
        } finally {
            setLoaded(true)
        }
        // Only needed to render an id as the name it was picked by, so a
        // failure costs legibility, not the page.
        workspaceService.list().then(setWorkspaces).catch(() => setWorkspaces([]))
        groupsService.list().then(setGroups).catch(() => setGroups([]))
    }, [])

    useEffect(() => { void refresh() }, [refresh])

    const grouped = useMemo(() => groupMappings(rows), [rows])

    async function remove(id: string) {
        setBusy(true)
        try {
            await ssoAdminService.deleteMapping(id)
            await refresh()
            onChanged?.()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    if (!loaded) {
        return (
            <div className="py-16 flex items-center justify-center gap-2 text-sm text-ink-muted">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading rules…
            </div>
        )
    }

    return (
        <div className="grid xl:grid-cols-[minmax(0,1fr)_320px] gap-6 items-start">
            <div className="min-w-0 space-y-5">
                {error && <ErrorBanner message={error} />}

                <SsoCard
                    icon={Sparkles}
                    title="New rule"
                    blurb="Reads left to right, and the preview underneath is exactly what gets saved."
                >
                    <MappingComposer
                        providers={providers}
                        onCreated={async () => { await refresh(); onChanged?.() }}
                        onError={setError}
                    />
                </SsoCard>

                <section>
                    <SsoSectionLabel
                        icon={Waypoints}
                        hint={grouped.length
                            ? `${rows.length} across ${grouped.length} group${grouped.length === 1 ? '' : 's'}`
                            : undefined}
                    >
                        Live rules
                    </SsoSectionLabel>

                    {grouped.length === 0 ? (
                        <SsoCard>
                            <SsoEmpty icon={Waypoints}>
                                No rules yet — nobody gains access by signing in.
                            </SsoEmpty>
                        </SsoCard>
                    ) : (
                        <div className="space-y-3">
                            {grouped.map((g, i) => (
                                <MappingGroupCard
                                    key={g.idpGroup}
                                    group={g}
                                    providers={providers}
                                    workspaces={workspaces}
                                    groups={groups}
                                    busy={busy}
                                    index={i}
                                    onDelete={id => { void remove(id) }}
                                />
                            ))}
                        </div>
                    )}
                </section>
            </div>

            <aside className="space-y-4 xl:sticky xl:top-6">
                <SsoCard
                    icon={RefreshCw}
                    tone="info"
                    title="Your directory decides who gets what"
                    blurb="Re-evaluated on every sign-in and every session refresh. Add someone to a group in your identity provider and their access appears here; remove them and it disappears within a few minutes, without anybody touching this page."
                >
                    <p className="text-[11px] text-ink-muted leading-relaxed">
                        Access granted this way cannot be edited by hand here — the
                        directory is the source of truth, and an override would be
                        undone at the next sign-in.
                    </p>
                </SsoCard>

                <SsoCard
                    icon={ShieldAlert}
                    tone="warn"
                    title="What cannot be granted this way"
                    blurb={<>
                        Platform-admin roles need a <strong>verified</strong>{' '}
                        connection, and <code className="font-mono">super_admin</code>{' '}
                        can never be granted automatically — that one stays a
                        deliberate, manual act, so it is not offered above.
                    </>}
                />
            </aside>
        </div>
    )
}
