/**
 * Admin → Versioned graphs: one home for every versioned graph and every setting they read.
 *
 *   Overview   where things stand, the fleet's figures, "Something's wrong?" and every graph
 *   Settings   every platform setting by category, with the one save model
 *   History    every change, who made it, when and why, and putting one back
 *
 * The tab is in `?tab=`; a link to a setting (`#reads-mode`) opens Settings at it. What is staged
 * on Settings stays staged while you look at the other tabs (and "Use recommended" in the
 * Overview's finder stages there), and isn't polled over: the values refresh only while nothing is.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, History, LayoutDashboard, SlidersHorizontal } from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { EmptyState } from '@/components/ui/EmptyState'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { settingAnchor, type ResolvedValues, type SettingValue } from '@/components/settings'
import { systemStatusService, type VersionedGraphRow } from '@/services/systemStatusService'
import {
    PLATFORM, signalCounts, useNodeMemory, useSettingsSchema, useSettingsValues, useSignals,
} from '@/services/settingsService'
import { GraphSettingsDrawer } from './GraphSettingsDrawer'
import { HistoryView } from './HistoryView'
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

    const nodes = useNodeMemory(tab === 'settings')
    const signalsQ = useSignals(Boolean(schema?.signals?.length))
    const signals = signalCounts(signalsQ.data)
    const facts = useMemo(() => ({ nodes: nodes.data }), [nodes.data])
    // The graph store providers: names for the list, and where a graph can move or be reseeded.
    const status = useQuery({ queryKey: ['admin', 'system-status'], queryFn: systemStatusService.get, staleTime: 60_000, refetchOnWindowFocus: false, enabled: tab === 'overview' })
    const providers = status.data?.graphProviders ?? []

    const [drawer, setDrawer] = useState<VersionedGraphRow | null>(null)
    const [drawerOpen, setDrawerOpen] = useState(false)
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
    const staged = editor.staged.dirtyCount

    let settingsBody
    if (schemaQ.error) settingsBody = <Failed what="what each setting is" error={schemaQ.error} onRetry={() => void schemaQ.refetch()} />
    else if (valuesQ.error) settingsBody = <Failed what="the platform’s settings" error={valuesQ.error} onRetry={() => void valuesQ.refetch()} />
    else if (!schema || !valuesQ.data) settingsBody = <SettingsSkeleton />
    else if (Object.keys(valuesQ.data.values).length === 0) {
        settingsBody = (
            <EmptyState icon={SlidersHorizontal} title="No settings to show"
                description="The server answered with no versioned-graph settings. Once it lists them, each appears here with its value and where it came from."
                action={{ label: 'Try again', onClick: () => void valuesQ.refetch() }} />
        )
    } else {
        settingsBody = (
            <SettingsView schema={schema} data={valuesQ.data} editor={editor} switches={switches} facts={facts} signals={signals}
                readOnly={valuesQ.data.editor !== 'system_admin'} />
        )
    }

    return (
        <PageContainer gutter="shell" className="py-8">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">Administration</p>
                    <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">Versioned graphs</h1>
                    <p className="mt-1 max-w-3xl text-sm text-ink-muted">
                        What readers see while new data loads, which graphs stay in memory, how new versions are built, and how long drafts last: each
                        setting with its value, where it came from, and what changing it does.
                    </p>
                </div>
                <Link to="/guide/versioned-graph-settings" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent-lineage hover:underline">
                    <BookOpen aria-hidden className="w-4 h-4" /> The settings guide
                </Link>
            </header>

            <Tabs value={tab} onValueChange={setTab} className="mt-6">
                <TabsList look="underline" aria-label="Versioned graphs" className="mb-8 overflow-x-auto">
                    <TabsTrigger value="overview" icon={LayoutDashboard}>Overview</TabsTrigger>
                    <TabsTrigger value="settings" icon={SlidersHorizontal}
                        badge={staged > 0 ? <span className="ml-0.5 rounded-full bg-accent-lineage px-1.5 text-[10px] font-semibold leading-4 text-white">{staged}<span className="sr-only"> not saved</span></span> : undefined}>
                        Settings
                    </TabsTrigger>
                    <TabsTrigger value="history" icon={History}>History</TabsTrigger>
                </TabsList>

                <TabsContent value="overview">
                    {schemaQ.error ? <Failed what="what each setting is" error={schemaQ.error} onRetry={() => void schemaQ.refetch()} />
                        : !schema ? <SettingsSkeleton />
                            : (
                                <Overview schema={schema} values={valuesQ.data?.values} switches={switches} signals={signals} providers={providers}
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
                    label={drawer.dataSourceLabel ?? drawer.dataSourceId} />
            )}
        </PageContainer>
    )
}
