/**
 * A workspace's versioned graphs, on its page (Workspace → Versioned graphs): the defaults its
 * graphs follow, within the platform's limits; its graphs, each with what it sets itself and the
 * read mode and class in force; and every change, with why.
 *
 *   Defaults   the settings page at workspace scope (`SettingsView scope="workspace"`): the same
 *              rows, lens, search, profiles, compass and save model as the platform's. What only
 *              the platform sets is listed read-only with its value here, and a category's switch
 *              is shown, not flipped (it is the platform's)
 *   Graphs     each graph with its own settings, read mode and class; its settings open in the drawer
 *   History    the workspace's changes and its graphs' (workspace admins, who may put one back)
 *
 * A workspace admin chooses within the platform's limits; a system admin may go past them (the
 * value is kept as an exception); anyone else reads. The sub-tab is in `?vg=`; a link to a setting
 * (`#reads-mode`) opens Defaults at it. What is staged stays staged while the other tabs are open,
 * the values aren't refreshed over it, and leaving the page (a reload, another page) asks first,
 * counting what a graph's drawer has staged (`LeaveGuard`).
 * The page keeps the tab while something is staged (`onStagedChange`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { BookOpen, History, Info, Network, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { settingAnchor, type ResolvedValues, type Scope, type SettingsFacts } from '@/components/settings'
import { usePermission } from '@/store/auth'
import { useFeature } from '@/store/features'
import {
    settingsKeys, useSettingsSchema, useSettingsValues, useWorkspaceGraphs, type SettingsPlace, type WorkspaceGraph,
} from '@/services/settingsService'
import { GraphSettingsDrawer } from './GraphSettingsDrawer'
import { HistoryView } from './HistoryView'
import { LeaveGuard } from './LeaveGuard'
import { graphName } from './meta'
import { SettingsView } from './SettingsView'
import { Failed, SettingsSkeleton } from './states'
import { useSettingsEditor } from './useSettingsEditor'
import { WorkspaceGraphs } from './WorkspaceGraphs'

const TABS = ['defaults', 'graphs', 'history'] as const
type Tab = (typeof TABS)[number]
const EMPTY: ResolvedValues = {}
const NO_FACTS: SettingsFacts = {}

/** A trigger's count of what is staged under it. */
function StagedCount({ n }: { n: number }) {
    return (
        <span className="ml-0.5 rounded-full bg-indigo-700 px-1.5 text-[10px] font-semibold leading-4 text-white dark:bg-indigo-600">
            {n}<span className="sr-only"> not saved</span>
        </span>
    )
}

export function WorkspaceVersionedGraphs({ workspaceId, workspaceName, onStagedChange }: {
    workspaceId: string
    workspaceName: string
    /** How many changes are staged, as it changes: the page keeps the tab (and says so) while any are. */
    onStagedChange?: (count: number) => void
}) {
    const place: SettingsPlace = useMemo(() => ({ scope: 'workspace', workspaceId }), [workspaceId])
    const [params, setParams] = useSearchParams()
    const location = useLocation()
    const qc = useQueryClient()
    const versioningOn = useFeature('versioningEnabled')
    // Reading the history and putting a change back are a workspace admin's (a system admin is one everywhere).
    const canAdmin = usePermission('workspace:admin', workspaceId)
    const schemaQ = useSettingsSchema()
    const dirty = useRef(false)
    const valuesQ = useSettingsValues(place, { staged: () => dirty.current })
    const graphsQ = useWorkspaceGraphs(workspaceId)
    const schema = schemaQ.data
    const byKey = useMemo(() => Object.fromEntries((schema?.settings ?? []).map((s) => [s.key, s])), [schema])
    const anchors = useMemo(() => new Set((schema?.settings ?? []).map((s) => settingAnchor(s.key))), [schema])
    const served = valuesQ.data?.values ?? EMPTY
    // A feature switch is the platform's (Admin → Versioned graphs): its why says so, with no button
    // here. With version control off, nothing here can be saved.
    const values = useMemo(() => Object.fromEntries(Object.entries(served).map(([k, r]) => [k, {
        ...r,
        why: r.why.some((w) => w.fix?.feature) ? r.why.map((w) => (w.fix?.feature ? { ...w, fix: null } : w)) : r.why,
        ...(versioningOn ? {} : { editable: false, editor: null }),
    }])), [served, versioningOn])
    const where = `the ${workspaceName} workspace`
    const editor = useSettingsEditor({ place, values, settings: byKey, where, refetch: valuesQ.refetch })
    const staged = editor.staged.dirtyCount
    useEffect(() => { dirty.current = staged > 0 })
    // What a graph's drawer has staged: leaving the page drops it too.
    const [drawerStaged, setDrawerStaged] = useState(0)
    useEffect(() => {
        onStagedChange?.(staged)
    }, [staged, onStagedChange])
    useEffect(() => () => onStagedChange?.(0), [onStagedChange])

    const tabs: readonly Tab[] = canAdmin ? TABS : TABS.filter((t) => t !== 'history')
    const asked = params.get('vg') as Tab | null
    // A link to a setting opens Defaults, whatever the tab says.
    const tab: Tab = anchors.has(location.hash.slice(1)) ? 'defaults' : asked && tabs.includes(asked) ? asked : 'defaults'
    const setTab = (next: string) => setParams((p) => {
        const out = new URLSearchParams(p)
        out.set('vg', next)
        return out
    }, { replace: true })

    const graphs = useMemo(() => graphsQ.data?.pages.flatMap((p) => p.graphs) ?? [], [graphsQ.data])
    const [drawer, setDrawer] = useState<WorkspaceGraph | null>(null)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const openSettings = useCallback((g: WorkspaceGraph) => { setDrawer(g); setDrawerOpen(true) }, [])
    const onDrawerOpenChange = (open: boolean) => {
        setDrawerOpen(open)
        // What the graph sets itself, and its read mode and class, may have changed there.
        if (!open) void qc.invalidateQueries({ queryKey: settingsKeys.workspaceGraphs(workspaceId) })
    }
    // The page opens a data source's panel from `?ds=`, on its Versioning tab.
    const openDataSource = (dataSourceId: string) => setParams((p) => {
        const out = new URLSearchParams(p)
        out.set('ds', dataSourceId)
        out.set('dstab', 'versioning')
        return out
    })
    // History names the workspace, and each graph by its data source's name.
    const placeName = useCallback((scope: Scope, scopeId: string) => {
        if (scope === 'workspace') return scopeId === workspaceId ? workspaceName : null
        const g = graphs.find((x) => x.dataSourceId === scopeId)
        return g ? graphName(g) : null
    }, [graphs, workspaceId, workspaceName])

    const data = valuesQ.data
    const readOnly = !versioningOn || data?.editor == null
    let defaults
    if (schemaQ.error) defaults = <Failed what="what each setting is" error={schemaQ.error} onRetry={() => void schemaQ.refetch()} />
    // A read again that failed keeps the values already read (and what is staged over them).
    else if (valuesQ.error && !valuesQ.data) defaults = <Failed what="this workspace’s settings" error={valuesQ.error} onRetry={() => void valuesQ.refetch()} />
    else if (!schema || !data) defaults = <SettingsSkeleton />
    else {
        defaults = (
            <div className="space-y-5">
                {!readOnly && (
                    <p role="note" className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-secondary">
                        <ShieldCheck aria-hidden className="mt-0.5 w-4 h-4 shrink-0 text-ink-secondary" />
                        {data.editor === 'system_admin'
                            ? 'As a system admin you can also choose values outside the platform’s limits here; each is kept as an exception, and the platform’s settings stay as they are.'
                            : 'You choose within the limits a system admin set for the platform. Each graph in this workspace follows these unless it sets its own.'}
                    </p>
                )}
                <SettingsView schema={schema} data={{ ...data, values }} editor={editor} facts={NO_FACTS} readOnly={readOnly}
                    scope="workspace" where={where} />
            </div>
        )
    }

    const listed = graphsQ.data && !graphsQ.hasNextPage ? graphs.length : null

    return (
        <div className="py-4">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                <div className="flex min-w-0 flex-1 basis-80 items-start gap-3">
                    <Info aria-hidden className="mt-0.5 w-4 h-4 shrink-0 text-indigo-700 dark:text-indigo-300" />
                    <p className="max-w-3xl text-sm leading-relaxed text-ink-secondary">
                        The defaults this workspace’s versioned graphs follow: what readers see while new data loads, how drafts and reviews
                        work, and how imports match rows. A graph follows them unless it sets its own; the platform decides what may be
                        chosen here.
                    </p>
                </div>
                <Link to="/guide/versioned-graph-settings"
                    className="inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-indigo-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:text-indigo-300">
                    <BookOpen aria-hidden className="w-4 h-4" /> The settings guide
                </Link>
            </div>

            <Tabs value={tab} onValueChange={setTab}>
                <TabsList aria-label="Versioned graphs in this workspace" className="mb-6 w-full max-w-md">
                    <TabsTrigger value="defaults" className="text-ink-secondary" icon={SlidersHorizontal} badge={staged > 0 ? <StagedCount n={staged} /> : undefined}>
                        Defaults
                    </TabsTrigger>
                    <TabsTrigger value="graphs" className="text-ink-secondary" icon={Network}
                        badge={listed !== null ? <span className="text-[11px] font-normal text-ink-secondary">{listed}<span className="sr-only"> graphs</span></span> : undefined}>
                        Graphs
                    </TabsTrigger>
                    {canAdmin && <TabsTrigger value="history" icon={History} className="text-ink-secondary">History</TabsTrigger>}
                </TabsList>

                <TabsContent value="defaults">{defaults}</TabsContent>
                <TabsContent value="graphs">
                    {schemaQ.error ? <Failed what="what each setting is" error={schemaQ.error} onRetry={() => void schemaQ.refetch()} />
                        : !schema ? <SettingsSkeleton />
                            : <WorkspaceGraphs workspaceId={workspaceId} schema={schema} onOpenSettings={openSettings} onOpenDataSource={openDataSource} />}
                </TabsContent>
                {canAdmin && (
                    <TabsContent value="history">
                        {schemaQ.error ? <Failed what="what each setting is" error={schemaQ.error} onRetry={() => void schemaQ.refetch()} />
                            : !schema ? <SettingsSkeleton />
                                : <HistoryView schema={schema} place={place} placeName={placeName} onGoToSettings={() => setTab('defaults')} />}
                    </TabsContent>
                )}
            </Tabs>

            {drawer && (
                <GraphSettingsDrawer workspaceId={workspaceId} graphId={drawer.graphId} open={drawerOpen} onOpenChange={onDrawerOpenChange}
                    label={graphName(drawer)} onStagedChange={setDrawerStaged} />
            )}
            <LeaveGuard count={staged + drawerStaged} what={drawerStaged ? 'these settings' : 'this workspace’s defaults'}
                onDiscard={() => editor.staged.reset()} />
        </div>
    )
}
