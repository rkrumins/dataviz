/**
 * MappingsTab — turning your org chart into access here.
 *
 * The page this replaces opened with a grid of labelled selects using our
 * schema's vocabulary ("Target type: Role binding (scope + role)"), two
 * fields asking for opaque ids nothing in the product will show you
 * (`ws_xxxxxxxx`, `grp_xxxxxxxx`), and an empty table underneath. Nowhere
 * did it say what a mapping *does*, which for this feature is the whole
 * point: these rules are re-evaluated on every sign-in and every refresh,
 * so removing someone from a group in your IdP removes their access here
 * within minutes. That is the promise, and it was invisible.
 *
 * Now: the promise up front, rules grouped by the IdP group they belong to
 * (because "what does engineering get?" is the question people arrive
 * with), and creation as a sentence rather than a schema.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2, RefreshCw, ShieldAlert, Waypoints } from 'lucide-react'

import {
    ssoAdminService,
    type IdpGroupMapping,
    type IdpProvider,
} from '@/services/ssoAdminService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { DocsLink } from '@/components/help/DocsLink'
import { ErrorBanner } from './ErrorBanner'
import { MappingComposer } from './mappings/MappingComposer'
import { MappingGroupCard, groupMappings } from './mappings/MappingGroupCard'

export function MappingsTab() {
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
        <div className="space-y-5 max-w-3xl">
            {error && <ErrorBanner message={error} />}

            {/* The contract. It is the reason to use this feature and the
                page never stated it. */}
            <motion.section
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16 }}
                className="rounded-2xl border-2 border-black/[0.08] dark:border-white/[0.10] p-5"
            >
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-xl bg-indigo-500/10 flex items-center justify-center">
                        <RefreshCw className="w-4 h-4 text-indigo-500" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-sm font-bold text-ink">
                            Your directory decides who gets what
                        </h2>
                        <p className="mt-1 text-xs text-ink-secondary leading-relaxed">
                            These rules are re-evaluated on every sign-in and every
                            session refresh. Add someone to a group in your identity
                            provider and their access appears here; remove them and
                            it disappears, within a few minutes, without anybody
                            touching this page.
                        </p>
                        <p className="mt-2 text-[11px] text-ink-muted leading-relaxed">
                            Access granted this way cannot be edited by hand here —
                            the directory is the source of truth, and an override
                            would be undone at the next sign-in.
                        </p>
                    </div>
                    <DocsLink slug="sso-setup" variant="icon" />
                </div>
            </motion.section>

            <MappingComposer
                providers={providers}
                onCreated={refresh}
                onError={setError}
            />

            {grouped.length === 0 ? (
                <EmptyRules />
            ) : (
                <section className="space-y-3">
                    <div className="flex items-baseline gap-2">
                        <h3 className="text-sm font-bold text-ink">Live rules</h3>
                        <span className="text-[11px] text-ink-muted">
                            {rows.length} across {grouped.length} group
                            {grouped.length === 1 ? '' : 's'}
                        </span>
                    </div>
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
                </section>
            )}

            <p className="flex items-start gap-1.5 text-[11px] text-ink-muted leading-relaxed">
                <ShieldAlert className="w-3.5 h-3.5 mt-px shrink-0" />
                Platform-admin roles need a <strong>verified</strong> connection,
                and <code className="font-mono">super_admin</code> can never be
                granted this way — that one stays a deliberate, manual act.
            </p>
        </div>
    )
}

function EmptyRules() {
    return (
        <div className="rounded-2xl border-2 border-dashed border-black/[0.10] dark:border-white/[0.12] p-8 text-center">
            <div className="w-11 h-11 mx-auto mb-3 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] flex items-center justify-center">
                <Waypoints className="w-5 h-5 text-ink-muted" />
            </div>
            <h3 className="text-sm font-semibold text-ink">No rules yet</h3>
            <p className="mt-1.5 text-xs text-ink-muted max-w-sm mx-auto leading-relaxed">
                Until you add one, people signing in through a connection arrive
                with no access beyond whatever their account already had. Start
                with the group most of your team is in.
            </p>
        </div>
    )
}
