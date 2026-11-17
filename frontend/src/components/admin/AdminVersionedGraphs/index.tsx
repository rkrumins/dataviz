/**
 * Admin → Versioned graphs: one home for every versioned graph and every setting they read.
 *
 *   Overview   where things stand, the fleet's figures, "Something's wrong?" and every graph
 *   Settings   every platform setting by category, with the one save model
 *   History    every change, who made it, when and why, and putting one back
 *
 * The tab is in `?tab=`; a link to a setting (`#reads-mode`) opens Settings at it. What is staged
 * on Settings stays staged while you look at the other tabs (and "Use recommended" in the
 * Overview's finder stages there), and isn't polled over: the values and node memory refresh only
 * while nothing is. Leaving for another page, or reloading, with anything staged (here or in a
 * graph's drawer) asks first. Each part is asked for where it is shown: the figures and the list
 * beside the registry, node memory on Settings, the signals where a finder shows them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, History, LayoutDashboard, SlidersHorizontal } from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { EmptyState } from '@/components/ui/EmptyState'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { settingAnchor, type ResolvedValues, type SettingValue } from '@/components/settings'
import { systemStatusService, type VersionedGraphRow } from '@/services/systemStatusService'
import {
    PLATFORM, settingsKeys, settingsService, signalCounts, useNodeMemory, useSettingsSchema, useSettingsValues, useSignals,
} from '@/services/settingsService'
import { GraphSettingsDrawer } from './GraphSettingsDrawer'
import { HistoryView } from './HistoryView'
import { LeaveGuard } from './LeaveGuard'
import { useFeatureSwitches } from './useFeatureSwitches'
import { categoryAnchor } from './meta'
import { Overview } from './Overview'
import { SettingsView } from './SettingsView'
import { Failed, SettingsSkeleton } from './states'
import { useSettingsEditor } from './useSettingsEditor'

const TABS = ['overview', 'settings', 'history'] as const
type Tab = (typeof TABS)[number]
const EMPTY: ResolvedValues = {}

export function AdminVersionedGraphs() {
    const [params, setParams] = useSearchParams()
    const location = useLocation()
    const navigate = useNavigate()
    const schemaQ = useSettingsSchema()
    const dirty = useRef(false)
    const valuesQ = useSettingsValues(PLATFORM, { staged: () => dirty.current })
    const schema = schemaQ.data
    const byKey = useMemo(() => Object.fromEntries((schema?.settings ?? []).map((s) => [s.key, s])), [schema])
    const anchors = useMemo(() => new Set((schema?.settings ?? []).map((s) => settingAnchor(s.key))), [schema])
    const editor = useSettingsEditor({ place: PLATFORM, values: valuesQ.data?.values ?? EMPTY, settings: byKey, where: 'the platform', refetch: valuesQ.refetch })
    useEffect(() => { dirty.current = editor.staged.dirtyCount > 0 })
    const switches = useFeatureSwitches()

    // A link to a setting opens Settings, whatever the tab says.
    const asked = params.get('tab') as Tab | null
    const tab: Tab = anchors.has(location.hash.slice(1)) ? 'settings' : asked && TABS.includes(asked) ? asked : 'overview'
    const setTab = (next: string) => setParams((p) => {
        const out = new URLSearchParams(p)
        out.set('tab', next)
        return out
    })

    const qc = useQueryClient()
    const staged = editor.staged.dirtyCount
    // The figures and the list don't need the registry: asked for beside it, not after it.
    useEffect(() => {
        if (tab !== 'overview') return
        void qc.prefetchQuery({ queryKey: settingsKeys.summary(), queryFn: settingsService.summary, staleTime: 15_000 })
        void qc.prefetchInfiniteQuery({
            queryKey: settingsKeys.graphs({}), queryFn: ({ pageParam }) => settingsService.graphs({}, pageParam), initialPageParam: null as string | null,
            staleTime: 15_000,
        })
    }, [tab, qc])
    // Node memory for the gauges: read on Settings, and not polled over staged values once read.
    const nodesRead = qc.getQueryData(settingsKeys.nodes()) !== undefined
    const nodes = useNodeMemory(tab === 'settings' && (staged === 0 || !nodesRead))
    // The signals, where a finder shows them: the Overview's, and Settings' while it is open.
    const [finderOpen, setFinderOpen] = useState(false)
    const signalsQ = useSignals(Boolean(schema?.signals?.length) && (tab === 'overview' || (tab === 'settings' && finderOpen)))
    const signals = signalCounts(signalsQ.data)
    const signalsUnavailable = signalsQ.data?.unavailable === true
    const facts = useMemo(() => ({ nodes: nodes.data }), [nodes.data])
    // The graph store providers: names for the list, and where a graph can move or be reseeded.
    const status = useQuery({ queryKey: ['admin', 'system-status'], queryFn: systemStatusService.get, staleTime: 60_000, refetchOnWindowFocus: false, enabled: tab === 'overview' })
    const providers = status.data?.graphProviders ?? []

    const [drawer, setDrawer] = useState<VersionedGraphRow | null>(null)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const [drawerStaged, setDrawerStaged] = useState(0)
    const openSettings = useCallback((row: VersionedGraphRow) => { setDrawer(row); setDrawerOpen(true) }, [])

    const showSetting = (key: string) => navigate({ search: '?tab=settings', hash: settingAnchor(key) })
    const goToSettings = (category?: string) => {
        setTab('settings')
        if (category) requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(categoryAnchor(category))?.scrollIntoView({ block: 'start' })))
    }
    const stageAndShow = (key: string, value: SettingValue) => {
        editor.stage(key, value)
        showSetting(key)
    }

    let settingsBody
    if (schemaQ.error) settingsBody = <Failed what="what each setting is" error={schemaQ.error} onRetry={() => void schemaQ.refetch()} />
    // A read again that failed keeps the values already read (and what is staged over them).
    else if (valuesQ.error && !valuesQ.data) settingsBody = <Failed what="the platform’s settings" error={valuesQ.error} onRetry={() => void valuesQ.refetch()} />
    else if (!schema || !valuesQ.data) settingsBody = <SettingsSkeleton />
    else if (Object.keys(valuesQ.data.values).length === 0) {
        settingsBody = (
            <EmptyState icon={SlidersHorizontal} title="No settings to show"
                description="The server answered with no versioned-graph settings. Once it lists them, each appears here with its value and where it came from."
                action={{ label: 'Try again', onClick: () => void valuesQ.refetch() }} />
        )
    } else {
        settingsBody = (
            <SettingsView schema={schema} data={valuesQ.data} editor={editor} switches={switches} facts={facts} signals={signals} signalsUnavailable={signalsUnavailable}
                onFinderOpenChange={setFinderOpen} readOnly={valuesQ.data.editor !== 'system_admin'} />
        )
    }

    return (
        <PageContainer gutter="shell" className="py-8">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">Administration</p>
                    <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">Versioned graphs</h1>
                    <p className="mt-1 max-w-3xl text-sm text-ink-secondary">
                        What readers see while new data loads, which graphs stay in memory, how new versions are built, and how long drafts last: each
                        setting with its value, where it came from, and what changing it does.
                    </p>
                </div>
                <Link to="/guide/versioned-graph-settings"
                    className="inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-indigo-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:text-indigo-300">
                    <BookOpen aria-hidden className="w-4 h-4" /> The settings guide
                </Link>
            </header>

            <Tabs value={tab} onValueChange={setTab} className="mt-6">
                <TabsList look="underline" aria-label="Versioned graphs" className="mb-8 overflow-x-auto">
                    <TabsTrigger value="overview" icon={LayoutDashboard} className="text-ink-secondary">Overview</TabsTrigger>
                    <TabsTrigger value="settings" icon={SlidersHorizontal} className="text-ink-secondary"
                        badge={staged > 0 ? <span className="ml-0.5 rounded-full bg-indigo-600 px-1.5 text-[10px] font-semibold leading-4 text-white">{staged}<span className="sr-only"> not saved</span></span> : undefined}>
                        Settings
                    </TabsTrigger>
                    <TabsTrigger value="history" icon={History} className="text-ink-secondary">History</TabsTrigger>
                </TabsList>

                <TabsContent value="overview">
                    {schemaQ.error ? <Failed what="what each setting is" error={schemaQ.error} onRetry={() => void schemaQ.refetch()} />
                        : !schema ? <SettingsSkeleton />
                            : (
                                <Overview schema={schema} values={valuesQ.data?.values} switches={switches} signals={signals} signalsUnavailable={signalsUnavailable} providers={providers}
                                    onShowSetting={showSetting} onStage={stageAndShow} onOpenSettings={openSettings} onGoToSettings={goToSettings} />
                            )}
                </TabsContent>
                <TabsContent value="settings">{settingsBody}</TabsContent>
                <TabsContent value="history">
                    {schemaQ.error ? <Failed what="what each setting is" error={schemaQ.error} onRetry={() => void schemaQ.refetch()} />
                        : !schema ? <SettingsSkeleton /> : <HistoryView schema={schema} onGoToSettings={() => setTab('settings')} />}
                </TabsContent>
            </Tabs>

            {drawer && (
                <GraphSettingsDrawer workspaceId={drawer.workspaceId} graphId={drawer.graphId} open={drawerOpen} onOpenChange={setDrawerOpen}
                    label={drawer.dataSourceLabel ?? drawer.dataSourceId} onStagedChange={setDrawerStaged} />
            )}
            <LeaveGuard count={staged + drawerStaged} what={drawerStaged ? 'these settings' : 'the platform’s settings'}
                onDiscard={() => editor.staged.reset()} />
        </PageContainer>
    )
}
