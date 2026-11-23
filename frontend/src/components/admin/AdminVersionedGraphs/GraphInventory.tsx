/**
 * GraphInventory — every versioned graph on the platform, forks and orphans (whose data source is
 * gone) included, a page at a time, with what its readers get, whether it is in memory, the graph
 * store copy it is read from, and its state. Moved here from Admin → Infrastructure, with the same
 * data and actions.
 *
 * Filters run on the server (state, kind, provider, the read mode in force, the class, graphs with
 * settings of their own, and a search); pages come by cursor; only the rows in view are drawn, so
 * thousands of graphs scroll as smoothly as ten.
 *
 * A phone shows each graph as a compact card: its name, its state, what its readers get and its
 * memory in one line, and its actions; "Details" opens the rest in place (the list measures the card
 * again as it grows). The Business view leaves out the graph store copy and "Reseed a provider…",
 * and filters by a search, the state and the read mode (another filter shows while it is set, as a
 * figure's link sets one); the Technical view has everything.
 *
 * Each row says what its readers get as the server resolves it: the mode in force, where it was
 * chosen, and, when the one chosen can't be had, which it was and why.
 *
 * Each row opens the graph's settings, and its menu rebuilds the copy (after a confirmation), checks
 * it against the database, loads an unloaded graph, moves a platform copy, adopts a connected
 * graph's copy onto a platform copy, opens the data source, or moves a fork to the trash. What each
 * action did is said under its row, in a cell of its own.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
    ChevronDown, Database, ExternalLink, Eye, FolderOpen, Hammer, HardDriveDownload, MoreHorizontal, MoveRight, RefreshCw, RotateCw, Search, Settings2,
    ShieldCheck, Trash2, Undo2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes, formatCount } from '@/lib/units'
import { MetricInfo } from '@/components/analytics/MetricInfo'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { DateTime } from '@/components/ui/DateTime'
import { EmptyState } from '@/components/ui/EmptyState'
import { HoverTip } from '@/components/ui/HoverTip'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { CATALOGUE, useLens } from '@/components/settings'
import { MoveProjectionDialog } from '@/components/admin/AdminInfrastructure/MoveProjectionDialog'
import { ReseedProviderDialog } from '@/components/admin/AdminInfrastructure/ReseedProviderDialog'
import { deleteFork, rebuildProjection, reconcileProjection, type BuildState } from '@/services/versioningApiService'
import {
    systemStatusService, type GraphProvider, type ProjectionBucket, type ResidencyState, type VersionedGraphRow,
} from '@/services/systemStatusService'
import { useGraphInventory, type GraphInventoryFilter } from '@/services/settingsService'

const READS = CATALOGUE.settings.find((s) => s.key === 'reads.mode')!
const CLASSES = CATALOGUE.settings.find((s) => s.key === 'residency.class')!
const choice = (s: typeof READS, id: string | null | undefined) => s.choices.find((c) => c.id === id)

const STATUS_OPTIONS: Array<{ value: ProjectionBucket; label: string }> = [
    { value: 'fresh', label: 'In sync' },
    { value: 'lagging', label: 'Catching up' },
    { value: 'projecting', label: 'Updating' },
    { value: 'rebuilding', label: 'Rebuilding' },
    { value: 'evicted', label: 'Unloaded' },
    { value: 'rehydrating', label: 'Loading' },
    { value: 'waiting_capacity', label: 'Waiting for room' },
    { value: 'building', label: 'Building a new version' },
    { value: 'failed', label: 'Failed' },
]

const KIND_OPTIONS: Array<{ value: NonNullable<GraphInventoryFilter['kind']>; label: string }> = [
    { value: 'main', label: 'Data source graphs' },
    { value: 'fork', label: 'Forks' },
    { value: 'orphan', label: 'Orphans' },
]

const STATE_CHIP: Record<ResidencyState, { label: string; tone: 'success' | 'neutral' | 'info' | 'warning' }> = {
    resident: { label: 'In memory', tone: 'success' },
    evicted: { label: 'Unloaded', tone: 'neutral' },
    rehydrating: { label: 'Loading', tone: 'info' },
    waiting_capacity: { label: 'Waiting for room', tone: 'warning' },
}

/** Whether a graph's copy is in memory, as its row and its health say it; a load, since when. */
export function ResidencyChip({ state, since }: { state: ResidencyState; since?: string | null }) {
    const chip = STATE_CHIP[state]
    return (
        <>
            <Badge tone={chip?.tone ?? 'neutral'} size="sm">{chip?.label ?? state}</Badge>
            {since && <DateTime at={since} prefix="since " className="text-[11px] text-ink-secondary" />}
        </>
    )
}

/** Where a graph's read mode was chosen, when it was chosen for it. */
const SOURCE_WORDS: Partial<Record<string, string>> = { graph: 'set on this graph', workspace: 'set for its workspace' }

const STATE_WORDS: Record<string, string> = {
    projecting: 'updating', rebuilding: 'rebuilding', evicted: 'unloaded', rehydrating: 'loading', waiting_capacity: 'waiting for room',
}

/** A build beside the copy that serves (switch when ready), by step: what its row says. */
const BUILD_CHIP: Record<BuildState['step'], string> = {
    queued: 'Build waiting', copying: 'Copying for a build', seeding: 'Building from the database',
    catching_up: 'Building new version', switching: 'Switching to new version',
}

function buildChip(b: BuildState): string {
    if (b.reason === 'move') return `Moving to ${b.target?.key ?? 'a new copy'}`
    if (b.reason === 'rebuild') return 'Rebuilding beside'
    return BUILD_CHIP[b.step] ?? b.step
}

/** What a build does, what readers see meanwhile, and why it waits or failed. */
function buildTitle(b: BuildState): string {
    return [
        b.reason === 'rebuild' ? 'The graph is rebuilt from the database in a new copy.' : '',
        b.reason === 'move' ? `The graph is written from the database into ${b.target?.key ?? 'its new copy'}.` : '',
        'Readers keep exactly the version served now until the new one is built and checked, then switch at once.',
        b.step === 'seeding' && b.reason !== 'rebuild' && b.reason !== 'move'
            ? 'Its copy is written from the database, as no copy fits or one is not wanted.' : '',
        b.step === 'seeding' && b.progress?.total ? `${Math.floor(((b.progress.done ?? 0) / b.progress.total) * 100)}% written.` : '',
        b.waiting ? `Waiting: ${b.waiting}.` : '',
        b.error ? `Attempt ${b.attempts ?? 1} failed: ${b.error}.` : '',
    ].filter(Boolean).join(' ')
}

type Refusal = { type?: string; reason?: string; message?: string }

const NOT_ADOPTED: Record<string, string> = {
    unpinned: 'This graph has no copy in the graph store yet, so there is nothing to adopt.',
    shared: 'Other data sources read this copy, so it can’t be adopted.',
}

/** A refusal in words: the server's own message where it gives one. */
function explain(e: Error & { detail?: unknown }): string {
    const d: Refusal = typeof e.detail === 'object' && e.detail ? e.detail as Refusal : {}
    if (d.type === 'projection_not_adopted') return NOT_ADOPTED[d.reason ?? ''] ?? d.message ?? e.message
    if (d.type === 'projection_mode_unsupported') return 'A data source with a dedicated rollup graph can’t be adopted.'
    if (d.type === 'job_active') return 'A rollup rebuild is running; try again when it finishes.'
    if (d.type === 'already_adopted') return 'This graph already uses a platform copy.'
    return d.message ?? e.message
}

type RowNote = { tone: 'ok' | 'warn' | 'bad'; text: string }
const NOTE_CLS: Record<RowNote['tone'], string> = {
    ok: 'text-emerald-700 dark:text-emerald-400',
    warn: 'text-amber-700 dark:text-amber-400',
    bad: 'text-rose-600 dark:text-rose-400',
}

function stateLabel(row: VersionedGraphRow): string {
    if (row.lastError) return 'Failed'
    if (row.status === 'idle') return row.lag > 0 ? 'Catching up' : 'In sync'
    const w = STATE_WORDS[row.status] ?? row.status
    return w.charAt(0).toUpperCase() + w.slice(1)
}

/** A state's chip on a phone's card: words and tone, never colour alone. */
function stateTone(row: VersionedGraphRow): BadgeTone {
    if (row.lastError) return 'danger'
    if (row.status === 'idle') return row.lag > 0 ? 'info' : 'success'
    if (row.status === 'waiting_capacity') return 'warning'
    return row.status === 'evicted' ? 'neutral' : 'info'
}

/** Room for the list's columns (Tailwind's `md`); a page with no `matchMedia` (a test's DOM) is taken to have it. */
const WIDE = '(min-width: 768px)'

function useWide(): boolean {
    const [wide, setWide] = useState(() => typeof window.matchMedia !== 'function' || window.matchMedia(WIDE).matches)
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return
        const mq = window.matchMedia(WIDE)
        const sync = () => setWide(mq.matches)
        sync()
        mq.addEventListener('change', sync)
        return () => mq.removeEventListener('change', sync)
    }, [])
    return wide
}

const nameOf = (row: VersionedGraphRow) => row.dataSourceLabel ?? row.dataSourceId
const DEFAULT_STORE = 'Default graph store'
const canAdopt = (row: VersionedGraphRow) => !row.owned && !row.forkParentGraphId && !row.orphan && Boolean(row.falkorGraphName)
    && row.falkorGraphName !== `gv_${row.graphId}`
const canLoad = (row: VersionedGraphRow) => !row.forkParentGraphId && (row.residencyState === 'evicted' || row.residencyState === 'waiting_capacity')

const COLS = 'md:grid md:grid-cols-[minmax(13rem,1.4fr)_minmax(11rem,1fr)_minmax(11rem,1fr)_minmax(9rem,0.8fr)_9rem] md:gap-x-4'
/** The Business view's: no graph store copy. */
const BUSINESS_COLS = 'md:grid md:grid-cols-[minmax(13rem,1.4fr)_minmax(13rem,1.3fr)_minmax(9rem,0.8fr)_9rem] md:gap-x-4'
const ITEM_CLS = cn(
    'flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-ink outline-none',
    'data-[highlighted]:bg-black/[0.05] dark:data-[highlighted]:bg-white/[0.07]',
    'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
)

function MenuItem({ icon: Icon, label, hint, disabled, onSelect }: {
    icon: typeof RefreshCw
    label: string
    hint?: string
    disabled?: boolean
    onSelect: () => void
}) {
    return (
        <DropdownMenu.Item className={ITEM_CLS} disabled={disabled} onSelect={onSelect}>
            <Icon aria-hidden className="mt-0.5 w-4 h-4 shrink-0 text-ink-muted" />
            <span className="min-w-0">
                <span className="block">{label}</span>
                {hint && <span className="block text-[11px] text-ink-secondary">{hint}</span>}
            </span>
        </DropdownMenu.Item>
    )
}

/** A cell, with its column's name above it on a phone. */
function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
    return (
        <div role="cell" className={cn('min-w-0', className)}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary md:hidden">{label}</p>
            {children}
        </div>
    )
}

/** A part of a graph's details on a phone's card, under its name. */
function Part({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">{label}</p>
            <div className="mt-0.5">{children}</div>
        </div>
    )
}

export function GraphInventory({ filter, onFilter, onOpenSettings, providers }: {
    filter: GraphInventoryFilter
    onFilter: (filter: GraphInventoryFilter) => void
    /** Opens a graph's settings drawer. */
    onOpenSettings: (row: VersionedGraphRow) => void
    providers: GraphProvider[]
}) {
    const navigate = useNavigate()
    const query = useGraphInventory(filter)
    const rows = query.data?.pages.flatMap((p) => p.graphs) ?? []
    // The latest page's count: the filters' graphs as the server last counted them.
    const total = query.data?.pages.at(-1)?.total
    const [search, setSearch] = useState(filter.q ?? '')
    const [busy, setBusy] = useState<string | null>(null)
    const [notes, setNotes] = useState<Record<string, RowNote>>({})
    const [moving, setMoving] = useState<VersionedGraphRow | null>(null)
    const [adopting, setAdopting] = useState<VersionedGraphRow | null>(null)
    const [trashing, setTrashing] = useState<VersionedGraphRow | null>(null)
    const [rebuilding, setRebuilding] = useState<VersionedGraphRow | null>(null)
    const rebuildReads = choice(READS, rebuilding?.readModeEffective)
    const providerName = new Map(providers.map((p) => [p.id, p.name]))
    const filtered = Object.keys(filter).length > 0
    const [lens] = useLens()
    const business = lens === 'business'
    // A filter the Business view doesn't offer still shows while it is set (a figure's link sets one), so it can be seen and cleared.
    const offers = (key: keyof GraphInventoryFilter) => !business || filter[key] !== undefined
    const wide = useWide()
    // The cards whose details are open on a phone, by graph: kept while a card scrolls out of view and back.
    const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
    const detailsId = useId()
    const toggleDetails = (graphId: string) => setOpened((was) => {
        const next = new Set(was)
        if (!next.delete(graphId)) next.add(graphId)
        return next
    })

    // The search runs on the server: as you pause, or at once on Enter.
    useEffect(() => {
        const t = setTimeout(() => {
            const q = search.trim()
            if (q !== (filter.q ?? '')) onFilter(set(filter, 'q', q || undefined))
        }, 350)
        return () => clearTimeout(t)
    }, [search, filter, onFilter])

    const scrollRef = useRef<HTMLDivElement>(null)
    // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer's functions are read at render, by design
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        // Each row or card is measured as drawn (`measureElement`), and again as it grows: a card's details opening.
        estimateSize: () => (wide ? 104 : 124),
        overscan: 6,
        getItemKey: (i) => rows[i]?.graphId ?? i,
    })

    const note = (graphId: string, n: RowNote) => setNotes((prev) => ({ ...prev, [graphId]: n }))

    const act = async (row: VersionedGraphRow, action: 'rebuild' | 'check' | 'load' | 'adopt' | 'trash') => {
        setBusy(`${row.graphId}:${action}`)
        try {
            if (action === 'rebuild') {
                const res = await rebuildProjection(row.workspaceId, row.graphId)
                note(row.graphId, res.alreadyRunning ? { tone: 'warn', text: 'A rebuild is already running' }
                    : res.beside ? { tone: 'ok', text: 'Rebuilding in a new copy: readers keep the current version until it is checked and switched to' }
                        : { tone: 'ok', text: 'Rebuild started' })
            } else if (action === 'check') {
                const r = await reconcileProjection(row.workspaceId, row.graphId)
                if (r.skippedReason) note(row.graphId, { tone: 'warn', text: `Not checked: ${r.skippedReason}` })
                else if (r.inSync) note(row.graphId, { tone: 'ok', text: 'In sync with the database' })
                else {
                    const missing = r.missingNodes.length + r.missingEdges.length
                    const extra = r.extraNodes.length + r.extraEdges.length
                    const parts = [missing && `${missing} missing`, extra && `${extra} extra`, r.mismatched.length && `${r.mismatched.length} different`].filter(Boolean)
                    note(row.graphId, { tone: 'bad', text: `Out of sync: ${parts.join(', ')}` })
                }
            } else if (action === 'load') {
                const res = await systemStatusService.loadGraph(row.graphId)
                note(row.graphId, res.loadRequested ? { tone: 'ok', text: 'Load asked for: it starts when its node has room' }
                    : { tone: 'warn', text: 'Already in memory, or being loaded' })
            } else if (action === 'adopt') {
                const res = await systemStatusService.adoptGraph(row.graphId)
                note(row.graphId, { tone: 'ok', text: `Adopting onto ${res.to.key}: reads come from the database until it catches up` })
                void query.refetch()
            } else {
                await deleteFork(row.workspaceId, row.graphId)
                note(row.graphId, { tone: 'ok', text: 'Moved to the trash; it can be restored from there' })
                void query.refetch() // the inventory lists live graphs only, so the row drops out
            }
        } catch (e) {
            note(row.graphId, { tone: 'bad', text: explain(e as Error) })
        } finally {
            setBusy(null)
            if (action === 'adopt') setAdopting(null)
            if (action === 'trash') setTrashing(null)
            if (action === 'rebuild') setRebuilding(null)
        }
    }

    const field = <K extends keyof GraphInventoryFilter>(key: K) => (value: string) =>
        onFilter(set(filter, key, (value === '' ? undefined : key === 'ownSettings' ? value === 'yes' : value) as GraphInventoryFilter[K]))

    const items = virtualizer.getVirtualItems()

    /** One graph: a row of the table, or, on a phone, a card whose details open in place. */
    const draw = (v: VirtualItem) => {
        const row = rows[v.index]
        const n = notes[row.graphId]
        const mine = busy?.startsWith(`${row.graphId}:`)
        const reads = choice(READS, row.readModeEffective)
        const declared = row.readModeDeclared && row.readModeDeclared !== row.readModeEffective
            ? choice(READS, row.readModeDeclared) : undefined
        const whyMode = row.readModeWhy?.[0]?.text
        const setWhere = row.readModeSource ? SOURCE_WORDS[row.readModeSource] : undefined
        const cls = choice(CLASSES, row.residency)
        // The state already says unloaded, loading or waiting for room, unless it says Failed: said once.
        const memory = !row.forkParentGraphId && row.residencyState && (row.residencyState !== row.status || row.lastError) ? row.residencyState : null
        const settings = (
            <Button size="sm" variant="secondary" leftIcon={Settings2} onClick={() => onOpenSettings(row)}
                aria-label={`Settings… for ${nameOf(row)}`} disabled={row.orphan} className="border-glass-border/80">
                Settings…
            </Button>
        )
        const name = (
            <>
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className={cn('max-w-full truncate', row.dataSourceLabel ? 'text-[13px] font-semibold text-ink' : 'font-mono text-[11.5px] text-ink-secondary')} title={row.graphId}>
                        {nameOf(row)}
                    </span>
                    {row.forkParentGraphId && <Badge tone="info" size="sm">Fork</Badge>}
                    {row.orphan && <Badge tone="warning" size="sm">Orphan</Badge>}
                </div>
                <p className="mt-0.5 truncate text-[11.5px] text-ink-secondary">{row.workspaceName ?? row.workspaceId}</p>
                {row.orphan && <p className="text-[11px] text-ink-secondary">Its data source no longer exists</p>}
            </>
        )
        const readsAndMemory = (
            <>
                <div className="flex flex-wrap items-center gap-1">
                    {!row.forkParentGraphId && reads && (
                        <MetricInfo definition={{ title: reads.title, what: reads.promise }}>
                            <Badge tone="neutral" size="sm">Reads: {reads.short}</Badge>
                        </MetricInfo>
                    )}
                    {!row.forkParentGraphId && reads && setWhere && <span className="text-[11px] text-ink-secondary">{setWhere}</span>}
                    {!row.forkParentGraphId && cls && (
                        <MetricInfo definition={{ title: cls.title, what: cls.promise }}>
                            <Badge tone="neutral" variant="outline" size="sm">Class: {cls.title}</Badge>
                        </MetricInfo>
                    )}
                    {memory && <ResidencyChip state={memory} since={row.rehydratingSince} />}
                    {row.build && (
                        <MetricInfo definition={{ title: buildChip(row.build), what: buildTitle(row.build) }}>
                            <Badge tone={row.build.error ? 'warning' : 'info'} size="sm">{buildChip(row.build)}</Badge>
                        </MetricInfo>
                    )}
                    {row.forkParentGraphId && <span className="text-[11.5px] text-ink-secondary">Follows the graph it was forked from</span>}
                </div>
                {!row.forkParentGraphId && declared && (
                    <p className="mt-1 text-[11px] leading-snug">
                        <span className="font-semibold text-amber-800 dark:text-amber-300">Chose {declared.short}</span>
                        {whyMode && <span className="block text-ink-secondary">{whyMode}</span>}
                    </p>
                )}
                {!row.forkParentGraphId && (row.sizeBytes != null || row.lastReadAt) && (
                    <p className="mt-1 text-[11px] text-ink-secondary">
                        {row.sizeBytes != null && formatBytes(row.sizeBytes)}
                        {row.sizeBytes != null && row.lastReadAt && ' · '}
                        {row.lastReadAt && <DateTime at={row.lastReadAt} prefix="read " />}
                    </p>
                )}
            </>
        )
        const copy = (
            <>
                <p className="text-[12.5px] text-ink-secondary">
                    {row.falkorProvider ? (providerName.get(row.falkorProvider) ?? row.falkorProvider) : DEFAULT_STORE}
                    <span className="ml-1.5 text-[11px] text-ink-secondary">{row.owned ? 'Platform copy' : 'Connected graph'}</span>
                </p>
                <p className="truncate font-mono text-[10.5px] text-ink-secondary" title={row.falkorGraphName ?? undefined}>{row.falkorGraphName ?? 'No copy yet'}</p>
                {row.retiredKeys.map((k) => (
                    <p key={`${k.provider}:${k.name}`} className="text-[10.5px] text-ink-secondary">
                        Previous copy {k.name} on {k.provider ? (providerName.get(k.provider) ?? k.provider) : DEFAULT_STORE}: removed once the new one catches up
                    </p>
                ))}
            </>
        )
        const state = (
            <>
                <p className="text-[12.5px] font-medium text-ink-secondary">
                    {stateLabel(row)}
                    {row.lag > 0 && <span className="font-normal text-ink-secondary"> · {formatCount(row.lag, 'versions')} behind</span>}
                </p>
                {row.lastError && <p className="line-clamp-2 break-words font-mono text-[10.5px] text-rose-700 dark:text-rose-300">{row.lastError}</p>}
                <p className="text-[11px] text-ink-secondary">{row.lastProjectedAt ? <DateTime at={row.lastProjectedAt} prefix="Updated " /> : 'Never updated'}</p>
            </>
        )
        const actions = (
            <>
                {/* Why it is off is said in the open too, under the graph's name. */}
                {row.orphan ? <HoverTip label="Its data source no longer exists" className="inline-flex">{settings}</HoverTip> : settings}
                <DropdownMenu.Root modal={false}>
                    <DropdownMenu.Trigger asChild>
                        <button type="button" aria-label={`More actions for ${nameOf(row)}`} disabled={busy !== null}
                            className="grid place-items-center w-7 h-7 rounded-lg text-ink-secondary outline-none hover:bg-black/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent-lineage/40 disabled:opacity-40 dark:hover:bg-white/10">
                            <MoreHorizontal aria-hidden className="w-4 h-4" />
                        </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                        <DropdownMenu.Content align="end" sideOffset={4}
                            className="z-[70] w-64 rounded-xl border border-glass-border/60 bg-canvas-elevated p-1 shadow-[0_18px_48px_-18px_rgba(15,23,42,0.45)] dark:shadow-[0_18px_48px_-18px_rgba(0,0,0,0.9)]">
                            <MenuItem icon={Hammer} label="Rebuild…" hint="Write its copy again from the database" onSelect={() => setRebuilding(row)} />
                            <MenuItem icon={ShieldCheck} label="Check sync" hint="Compare the copy with the database" onSelect={() => void act(row, 'check')} />
                            {canLoad(row) && <MenuItem icon={HardDriveDownload} label="Load now" onSelect={() => void act(row, 'load')} />}
                            <MenuItem icon={MoveRight} label="Move…" disabled={!row.owned || row.orphan}
                                hint={!row.owned ? 'Only platform copies move; this is a connected graph' : row.orphan ? 'Its data source no longer exists' : undefined}
                                onSelect={() => setMoving(row)} />
                            {canAdopt(row) && <MenuItem icon={RefreshCw} label="Adopt…" hint="Read from a platform copy instead" onSelect={() => setAdopting(row)} />}
                            <MenuItem icon={FolderOpen} label="Open data source" disabled={row.orphan}
                                hint={row.orphan ? 'Its data source no longer exists' : undefined}
                                onSelect={() => navigate(`/workspaces/${row.workspaceId}?ds=${encodeURIComponent(row.dataSourceId)}&dstab=versioning`)} />
                            {row.forkParentGraphId && <MenuItem icon={Trash2} label="Move to trash…" onSelect={() => setTrashing(row)} />}
                        </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                </DropdownMenu.Root>
            </>
        )
        const done = (
            <>
                {mine && <p className="text-[11.5px] text-ink-secondary">Working…</p>}
                {n && !mine && <p className={cn('text-[12px]', NOTE_CLS[n.tone])}>{n.text}</p>}
            </>
        )
        const place = { transform: `translateY(${v.start}px)` }

        if (!wide) {
            const open = opened.has(row.graphId)
            const id = `${detailsId}-${v.index}`
            // What its readers get and its memory, in one line: the details hold the rest. "Reads" is the eye, as its
            // category's icon, and said to a screen reader.
            const line = [reads?.short, memory && STATE_CHIP[memory]?.label, row.sizeBytes != null && formatBytes(row.sizeBytes)].filter(Boolean).join(' · ')
            return (
                <div key={v.key} ref={virtualizer.measureElement} data-index={v.index} role="listitem"
                    className="absolute left-0 top-0 w-full border-b border-glass-border/40 px-4 py-3.5 last:border-b-0" style={place}>
                    <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">{name}</div>
                        <Badge tone={stateTone(row)} size="md" className="mt-0.5 shrink-0">{stateLabel(row)}</Badge>
                    </div>
                    {row.forkParentGraphId ? <p className="mt-1.5 text-[12px] text-ink-secondary">Follows the graph it was forked from</p> : line && (
                        <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] text-ink-secondary">
                            {reads && <Eye aria-hidden className="w-3.5 h-3.5 shrink-0" />}
                            <span className="min-w-0 truncate" title={reads ? `Reads: ${line}` : line}>
                                {reads && <span className="sr-only">Reads: </span>}{line}
                            </span>
                        </p>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-2">
                        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => toggleDetails(row.graphId)}
                            className="inline-flex items-center gap-1 rounded text-[12px] font-semibold text-indigo-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:text-indigo-300">
                            Details<span className="sr-only">: {nameOf(row)}</span>
                            <ChevronDown aria-hidden className={cn('w-3.5 h-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
                        </button>
                        <div className="flex shrink-0 items-center gap-1">{actions}</div>
                    </div>
                    <div id={id} hidden={!open} className="mt-3 space-y-3 border-t border-glass-border/40 pt-3">
                        {open && (
                            <>
                                <Part label="Reads and memory">{readsAndMemory}</Part>
                                {!business && <Part label="Graph store copy">{copy}</Part>}
                                <Part label="State">{state}</Part>
                            </>
                        )}
                    </div>
                    <div aria-live="polite" className={cn((mine || n) && 'mt-2')}>{done}</div>
                </div>
            )
        }
        return (
            <div key={v.key} ref={virtualizer.measureElement} data-index={v.index} role="row" aria-rowindex={v.index + 2}
                className={cn(business ? BUSINESS_COLS : COLS, 'absolute left-0 top-0 w-full space-y-3 border-b border-glass-border/40 px-5 py-4 last:border-b-0 md:space-y-0')}
                style={place}>
                <Cell label="Graph">{name}</Cell>
                <Cell label="Reads and memory">{readsAndMemory}</Cell>
                {!business && <Cell label="Graph store copy">{copy}</Cell>}
                <Cell label="State">{state}</Cell>
                <div role="cell" className="flex items-start gap-1.5 md:justify-end">{actions}</div>
                {/* What the last action did, in a cell of its own: under the row, across it. */}
                <div role="cell" className={cn(business ? 'md:col-span-4' : 'md:col-span-5', (mine || n) && 'md:mt-2')} aria-live="polite">{done}</div>
            </div>
        )
    }
    // Only the graphs in view are drawn; the list scrolls inside its card.
    const scroller = (
        <div ref={scrollRef} tabIndex={0} aria-label={wide ? 'Graphs, scroll for more' : 'Versioned graphs, scroll for more'} role={wide ? 'rowgroup' : 'list'}
            className="max-h-[min(70vh,44rem)] overflow-y-auto overscroll-contain outline-none [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-lineage/40">
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>{items.map(draw)}</div>
        </div>
    )

    return (
        <section aria-labelledby="inventory-title" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h2 id="inventory-title" className="text-lg font-semibold tracking-tight text-ink">Every versioned graph</h2>
                    <p className="text-[13px] text-ink-secondary">
                        {business ? 'Forks and orphans included, each with what its readers get and its state.'
                            : 'Forks and orphans included, each with the copy it is read from and its state.'}
                    </p>
                </div>
                {!business && <ReseedMenu providers={providers} />}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <form className="w-full sm:w-72" role="search" onSubmit={(e) => { e.preventDefault(); onFilter(set(filter, 'q', search.trim() || undefined)) }}>
                    <Input aria-label="Search" size="sm" value={search} onChange={(e) => setSearch(e.target.value)}
                        placeholder={business ? 'Search by name' : 'Name, id or copy'} leading={<Search aria-hidden className="w-3.5 h-3.5" />} />
                </form>
                <Select size="sm" aria-label="Status" value={filter.status ?? ''} onChange={field('status')}
                    options={[{ value: '', label: 'Any state' }, ...STATUS_OPTIONS]} />
                {offers('kind') && (
                    <Select size="sm" aria-label="Kind" value={filter.kind ?? ''} onChange={field('kind')}
                        options={[{ value: '', label: 'All graphs' }, ...KIND_OPTIONS]} />
                )}
                <Select size="sm" aria-label="Readers get" value={filter.readModeEffective ?? ''} onChange={field('readModeEffective')}
                    options={[{ value: '', label: 'Any read mode' }, ...READS.choices.map((c) => ({ value: c.id, label: c.short }))]} />
                {offers('residency') && (
                    <Select size="sm" aria-label="Class" value={filter.residency ?? ''} onChange={field('residency')}
                        options={[{ value: '', label: 'Any class' }, ...CLASSES.choices.map((c) => ({ value: c.id, label: c.title }))]} />
                )}
                {offers('ownSettings') && (
                    <Select size="sm" aria-label="Own settings" value={filter.ownSettings === undefined ? '' : filter.ownSettings ? 'yes' : 'no'}
                        onChange={field('ownSettings')}
                        options={[{ value: '', label: 'With or without own settings' }, { value: 'yes', label: 'With settings of their own' }, { value: 'no', label: 'Following their workspace' }]} />
                )}
                {offers('provider') && (
                    <Select size="sm" aria-label="Provider" value={filter.provider ?? ''} onChange={field('provider')}
                        options={[{ value: '', label: 'All providers' }, { value: 'default', label: DEFAULT_STORE },
                            ...providers.filter((p) => p.type === 'falkordb').map((p) => ({ value: p.id, label: p.name }))]} />
                )}
                {filtered && (
                    <Button size="sm" variant="ghost" leftIcon={Undo2} onClick={() => { setSearch(''); onFilter({}) }} className="text-ink-secondary">Clear filters</Button>
                )}
            </div>

            {query.isPending ? (
                <div aria-busy="true" aria-label="Loading the graphs" className="space-y-2">
                    {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
                </div>
            ) : query.error ? (
                <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] px-4 py-3">
                    <p className="min-w-0 flex-1 text-[13px] text-rose-700 dark:text-rose-300">Couldn’t list the graphs: {(query.error as Error).message}</p>
                    <Button size="sm" leftIcon={RotateCw} onClick={() => void query.refetch()}>Try again</Button>
                </div>
            ) : rows.length === 0 ? (
                <EmptyState
                    icon={Database}
                    title={filtered ? 'No graph matches these filters' : 'No versioned graphs yet'}
                    description={filtered ? 'Try fewer filters, or another search.' : 'A data source’s graph is listed here once versioning is turned on for it, on the data source’s Versioning tab in its workspace.'}
                    action={filtered
                        ? { label: 'Clear filters', onClick: () => { setSearch(''); onFilter({}) } }
                        : { label: 'Open workspaces', onClick: () => navigate('/workspaces') }}
                />
            ) : (
                <div className="rounded-2xl border border-glass-border/50 bg-canvas-elevated">
                    {wide ? (
                        <div role="table" aria-label="Versioned graphs" aria-rowcount={rows.length + 1}>
                            {/* The same gutter as the list's scrollbar, so each column sits over its own. */}
                            <div role="rowgroup" className="hidden overflow-hidden border-b border-glass-border/50 [scrollbar-gutter:stable] md:block">
                                <div role="row" aria-rowindex={1} className={cn(business ? BUSINESS_COLS : COLS, 'px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary')}>
                                    <span role="columnheader">Graph</span>
                                    <span role="columnheader">Reads and memory</span>
                                    {!business && <span role="columnheader">Graph store copy</span>}
                                    <span role="columnheader">State</span>
                                    <span role="columnheader"><span className="sr-only">Actions</span></span>
                                    <span role="columnheader" className="sr-only">What the last action did</span>
                                </div>
                            </div>
                            {scroller}
                        </div>
                    ) : scroller}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-glass-border/50 px-5 py-3 text-[12px] text-ink-secondary">
                        <span>
                            {total === undefined
                                ? `${formatCount(rows.length)} ${rows.length === 1 ? 'graph' : 'graphs'} shown${query.hasNextPage ? ', more to load' : ''}`
                                : `${formatCount(rows.length)} of ${formatCount(total)} ${total === 1 ? 'graph' : 'graphs'} shown`}
                        </span>
                        {query.hasNextPage && (
                            <Button size="sm" variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more</Button>
                        )}
                    </div>
                </div>
            )}

            <ConfirmDialog
                open={rebuilding !== null}
                onOpenChange={(open) => { if (!open) setRebuilding(null) }}
                title="Rebuild this graph’s copy?"
                confirmLabel="Rebuild"
                pending={rebuilding !== null && busy === `${rebuilding.graphId}:rebuild`}
                onConfirm={() => (rebuilding ? act(rebuilding, 'rebuild') : undefined)}
            >
                {rebuilding && (
                    <>
                        {nameOf(rebuilding)}’s copy in the graph store is written again from the database. Meanwhile its readers are
                        served as its read mode says{rebuildReads ? ` (${rebuildReads.title})` : ''}.
                    </>
                )}
            </ConfirmDialog>

            <ConfirmDialog
                open={adopting !== null}
                onOpenChange={(open) => { if (!open) setAdopting(null) }}
                title="Adopt onto a platform copy"
                confirmLabel="Adopt"
                pending={adopting !== null && busy === `${adopting.graphId}:adopt`}
                onConfirm={() => (adopting ? act(adopting, 'adopt') : undefined)}
            >
                {adopting && (
                    <div className="space-y-2">
                        <p>
                            {nameOf(adopting)} is copied from the database into a new platform copy on the same graph store, a page at a
                            time; reads come from the database until the copy catches up. From then the platform reads its own copy, and
                            the graph’s residency class applies.
                        </p>
                        <p>
                            <span className="font-mono">{adopting.falkorGraphName}</span> is left exactly as it is: never written, dropped or
                            renamed. It keeps its memory too, so the graph then takes the room of two copies until that copy is cleared.
                        </p>
                        <p className="text-amber-700 dark:text-amber-400">
                            Changes other tools keep making to {adopting.falkorGraphName} no longer show here, and Bring into history no
                            longer sees them.
                        </p>
                        <p className="text-amber-700 dark:text-amber-400">
                            The platform copy holds the ontology’s spelling of each type: a native query or a saved query written against
                            the connected graph’s own spelling (<span className="font-mono">:table</span> for <span className="font-mono">:Table</span>)
                            needs the ontology’s from then.
                        </p>
                    </div>
                )}
            </ConfirmDialog>

            <ConfirmDialog
                open={trashing !== null}
                onOpenChange={(open) => { if (!open) setTrashing(null) }}
                title="Move this fork to the trash?"
                confirmLabel="Move to trash"
                tone="danger"
                pending={trashing !== null && busy === `${trashing.graphId}:trash`}
                onConfirm={() => (trashing ? act(trashing, 'trash') : undefined)}
            >
                {trashing && <>{nameOf(trashing)} leaves the list. It can be restored from the trash until its restore window ends.</>}
            </ConfirmDialog>

            {moving && (
                <MoveProjectionDialog
                    row={moving}
                    providers={providers}
                    onClose={() => setMoving(null)}
                    onMoved={(res) => {
                        setMoving(null)
                        note(res.graphId, res.cancelled
                            ? { tone: 'ok', text: res.beside ? `Move cancelled: the rebuild it carried goes on beside ${res.from.key}` : 'Move cancelled' }
                            : res.beside && res.changed
                                ? { tone: 'ok', text: `Building ${res.to.key} beside ${res.from.key}: readers stay on it until the new copy is checked and switched to` }
                                : res.beside ? { tone: 'ok', text: `Already moving to ${res.to.key}` }
                                    : res.changed ? { tone: 'ok', text: `Moving to ${res.to.key}: reads come from the database until it catches up` }
                                        : { tone: 'ok', text: 'Already there' })
                        void query.refetch()
                    }}
                />
            )}
        </section>
    )
}

/** The filter with one field set, or left out. */
function set<K extends keyof GraphInventoryFilter>(filter: GraphInventoryFilter, key: K, value: GraphInventoryFilter[K] | undefined): GraphInventoryFilter {
    const next = { ...filter }
    if (value === undefined) delete next[key]
    else next[key] = value
    return next
}

/** "Reseed a provider…": after a graph store was restored, reseed its graphs from the database. */
function ReseedMenu({ providers }: { providers: GraphProvider[] }) {
    const [target, setTarget] = useState<GraphProvider | null>(null)
    const stores = providers.filter((p) => p.type === 'falkordb')
    if (!stores.length) return null
    return (
        <>
            <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger asChild>
                    <Button size="sm" variant="secondary" leftIcon={RotateCw} className="border-glass-border/80">Reseed a provider…</Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={4}
                        className="z-[70] w-72 rounded-xl border border-glass-border/60 bg-canvas-elevated p-1 shadow-[0_18px_48px_-18px_rgba(15,23,42,0.45)] dark:shadow-[0_18px_48px_-18px_rgba(0,0,0,0.9)]">
                        <DropdownMenu.Label className="px-3 pb-1 pt-2 text-[11px] text-ink-secondary">
                            Use after a graph store was restored or rebuilt: its graphs are written again from the database.
                        </DropdownMenu.Label>
                        {stores.map((p) => (
                            <MenuItem key={p.id} icon={ExternalLink} label={p.name}
                                hint={p.versionedGraphs != null ? `${formatCount(p.versionedGraphs)} versioned graphs` : undefined}
                                onSelect={() => setTarget(p)} />
                        ))}
                    </DropdownMenu.Content>
                </DropdownMenu.Portal>
            </DropdownMenu.Root>
            {/* Its own confirmation counts the graphs first (a dry run), then reseeds them. */}
            {target && <ReseedProviderDialog provider={target} onClose={() => setTarget(null)} />}
        </>
    )
}
