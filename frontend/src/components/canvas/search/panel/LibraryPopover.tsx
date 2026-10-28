/**
 * LibraryPopover — unified discovery surface for search queries.
 *
 * Replaces the old ``TemplatesStrip`` which had three tabs
 * (Quick starts / Browse all / Recent) buried behind an unlabeled icon.
 * This popover has four tabs:
 *
 *   Mine         — user-saved queries (promoted from Recent via "Save as…")
 *                  + pinned recents. Per-user, localStorage-backed.
 *   This view    — the queries saved in the view's library, on the server,
 *                  for everyone who can open the view. Someone who can
 *                  edit the view saves and removes them (and shares one
 *                  of their own from Mine).
 *   Other views  — the queries saved on the workspace's other views the
 *                  user may open, and their own saved on other views: to
 *                  run here, or copy into this view's library.
 *   Recipes      — ready-made questions, by what someone sets out to do,
 *                  in the view's own words and each with how many it finds.
 *
 * A single text input filters across every tab, so the user can ask "do I
 * have anything saved about PII?" without remembering whether they saved
 * it themselves, a teammate did, or it's a recipe.
 *
 * Any saved query downloads as a file of its own, and makes a display
 * rule in one step (for someone who can edit the view). A footer opens a
 * query from a file, and takes the view's whole library — its saved
 * queries and its display rules — to a file and (for someone who can
 * edit the view) brings one in: the same pack and import dialog as the
 * Property Manager's, so neither surface is the only way there.
 */
import * as Popover from '@radix-ui/react-popover'
import { motion } from 'framer-motion'
import {
    ArrowDownToLine, BookmarkPlus, CopyPlus, FolderOpen, LayoutGrid, Loader2, Package, Pin,
    PinOff, Search as SearchIcon, Star, Tags, Trash2, Upload, Users, Waypoints, X,
} from 'lucide-react'
import { type FC, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { LibraryImportDialog } from '@/components/canvas/property-manager/LibraryImportDialog'
import {
    type QueryToKeep, readQueryFile, saveLibraryFile, saveQueryFile,
} from '@/components/canvas/property-manager/libraryFile'
import { useAppNotifications } from '@/components/ui/notifications'
import { cn } from '@/lib/utils'
import { httpStatusOf } from '@/services/graphRequestFailure'
import {
    exportViewLibrary,
    type LibraryImportResult,
    type LibraryPack,
    listQueriesFromOtherViews,
    type OtherViewQuery,
    type SavedViewQuery,
} from '@/services/viewLibraryService'
import { type RecentQueryEntry, useSearchStore } from '@/store/searchStore'
import { useLibraryCanEdit, useSavedViewQueries, useViewLibraryStore } from '@/store/viewLibraryStore'
import type { Predicate } from '@/types/search'

import { NO_RULE_FOR_CONNECTIONS, asDraft, queryLabel } from './findMode'
import type { Recipe } from './recipes/recipes'
import { ViewRecipes } from './recipes/ViewRecipes'


type LibraryTab = 'mine' | 'shared' | 'others' | 'recipes'

// The popover and the import dialog are portals, and React bubbles a
// portal's key presses through its React parents — up to SearchMapPanel,
// which takes Enter, the arrows and J/K to step through and reveal matches.
// A key pressed on this layer's buttons is theirs.
const keepKeysHere = (e: KeyboardEvent) => e.stopPropagation()


export interface LibraryPopoverProps {
    /** The anchor element. Typically the "Library" toolbar chip in
     *  CompactHeader. Rendered as the popover trigger. */
    children: ReactNode
    /** Externally-controlled open state so the toolbar chip's
     *  ``active`` styling stays in sync with the popover. */
    open: boolean
    onOpenChange: (open: boolean) => void
    /** Per-view recent queries (already filtered + sorted by store). */
    recentQueries: ReadonlyArray<RecentQueryEntry>
    /** The view the recipes are for. */
    viewId: string
    /** Start from a recipe. Closes the popover. */
    onPickRecipe: (recipe: Recipe) => void
    /** Load a saved/recent query into the QueryCard. Closes the popover. */
    onLoadRecent: (entry: RecentQueryEntry) => void
    /** Toggle the pin state of a recent entry. */
    onTogglePinRecent: (timestamp: number) => void
    /** Remove a recent entry. */
    onRemoveRecent: (timestamp: number) => void
    /** Open the Save-as dialog for the given recent entry — to name it,
     *  or to share it with the view. The dialog itself is owned by
     *  SearchMapPanel so it survives popover close — when the dialog
     *  mounts, the popover dismisses naturally (and the dialog keeps
     *  rendering at viewport level via its own portal). */
    onSaveAs: (entry: RecentQueryEntry) => void
    /** Load one of the view's saved queries into the QueryCard. Closes
     *  the popover. */
    onLoadSaved: (query: SavedViewQuery) => void
    /** Whether the active draft has filters — a recipe replaces them,
     *  and the Recipes tab says so. */
    activeDraft: boolean
    /** Make a display rule of a saved query (offered to someone who can
     *  edit the view). Closes the popover. */
    onMakeRule?: (predicate: Predicate, name: string) => void
}


export const LibraryPopover: FC<LibraryPopoverProps> = ({
    children, open, onOpenChange,
    viewId, recentQueries, onPickRecipe, onLoadRecent, onTogglePinRecent,
    onRemoveRecent, onSaveAs, onLoadSaved, activeDraft, onMakeRule,
}) => {
    const savedQueries = useSavedViewQueries()
    // Open on what the view keeps, then on the user's own; fall back to
    // Recipes on a first session so the popover isn't empty.
    const [tab, setTab] = useState<LibraryTab>(
        savedQueries.length > 0 ? 'shared' : recentQueries.length > 0 ? 'mine' : 'recipes',
    )
    const [filter, setFilter] = useState('')

    // The view's library as a file — the pack the Property Manager
    // exports and imports. The import dialog lives outside the popover,
    // so it survives the popover closing as it opens.
    const libraryViewId = useViewLibraryStore((s) => s.viewId)
    const branchId = useViewLibraryStore((s) => s.branchId)
    const canEdit = useLibraryCanEdit()
    const [importOpen, setImportOpen] = useState(false)
    // A library file opened as a query but holding several: imported whole.
    const [importPack, setImportPack] = useState<{ pack: LibraryPack; fileName: string } | null>(null)
    const [exporting, setExporting] = useState(false)
    const { notify } = useAppNotifications()
    const fileInput = useRef<HTMLInputElement>(null)

    // What a row does besides loading — offered once, to every tab.
    const keep = (query: QueryToKeep, from?: { viewId: string; viewName?: string | null }) =>
        saveQueryFile(query, from ?? { viewId })
    const makeRule = onMakeRule && canEdit
        ? (query: QueryToKeep) => { onOpenChange(false); onMakeRule(query.predicate, query.name) }
        : undefined

    // A query from a file opens in the card; a library file of several
    // goes to the import dialog — for someone who may add to the library.
    const openFile = async (file: File | undefined) => {
        if (!file) return
        try {
            const opened = await readQueryFile(file)
            if (opened.kind === 'query') {
                onLoadSaved({ id: `file:${file.name}`, ...opened.query })
                onOpenChange(false)
                return
            }
            const queries = opened.pack.savedQueries?.length ?? 0
            const rules = opened.pack.displayRules?.length ?? 0
            if (!canEdit) {
                notify('warning', `This library file holds ${queries} ${queries === 1 ? 'query' : 'queries'} and ${rules} `
                    + `${rules === 1 ? 'rule' : 'rules'} — someone who can edit this view can import it.`)
                return
            }
            onOpenChange(false)
            setImportPack({ pack: opened.pack, fileName: file.name })
        } catch (e) {
            notify('error', (e as Error).message)
        }
    }

    const handleExport = async () => {
        if (!libraryViewId) return
        setExporting(true)
        try {
            saveLibraryFile(await exportViewLibrary(libraryViewId, branchId))
        } catch (e) {
            notify('error', `Couldn't export the library — ${(e as Error).message}`)
        } finally {
            setExporting(false)
        }
    }

    const handleImported = (result: LibraryImportResult) => {
        setImportOpen(false)
        notify('success', `Imported ${result.added.toLocaleString()} ${result.added === 1 ? 'item' : 'items'} into this view`)
    }

    return (
        <>
        <Popover.Root open={open} onOpenChange={onOpenChange}>
            {/* Anchor instead of Trigger: the popover is controlled
                externally (by the toolbar's Library chip), so clicking
                the chip toggles ``open`` directly. The anchor just
                positions the popover under the header. */}
            <Popover.Anchor asChild>{children}</Popover.Anchor>
            <Popover.Portal>
                <Popover.Content
                    align="end"
                    sideOffset={8}
                    collisionPadding={12}
                    onKeyDown={keepKeysHere}
                    className={cn(
                        'w-[420px] max-w-[calc(100vw-24px)] max-h-[70vh] rounded-xl overflow-hidden',
                        'bg-canvas-elevated/98 backdrop-blur-2xl',
                        'border border-glass-border shadow-2xl shadow-black/25',
                        'z-50 flex flex-col',
                    )}
                >
                    <Header
                        filter={filter}
                        onFilterChange={setFilter}
                        onClose={() => onOpenChange(false)}
                    />
                    <Tabs
                        tab={tab}
                        onChange={setTab}
                        mineCount={recentQueries.length}
                        sharedCount={savedQueries.length}
                    />
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3">
                        {tab === 'mine' && (
                            <MineTab
                                entries={recentQueries}
                                filter={filter}
                                onLoad={(e) => { onLoadRecent(e); onOpenChange(false) }}
                                onKeep={(e) => keep(mineQuery(e))}
                                onMakeRule={makeRule && ((e) => makeRule(mineQuery(e)))}
                                onTogglePin={onTogglePinRecent}
                                onRemove={onRemoveRecent}
                                onSaveAs={(e) => {
                                    // Close popover first so the dialog
                                    // is the only modal layer visible.
                                    // The dialog's lifecycle is owned
                                    // by the parent (SearchMapPanel) so
                                    // it survives this close.
                                    onOpenChange(false)
                                    onSaveAs(e)
                                }}
                            />
                        )}
                        {tab === 'shared' && (
                            <SharedTab
                                queries={savedQueries}
                                filter={filter}
                                onLoad={(q) => { onLoadSaved(q); onOpenChange(false) }}
                                onKeep={(q) => keep(q)}
                                onMakeRule={makeRule}
                            />
                        )}
                        {tab === 'others' && (
                            <OthersTab
                                viewId={viewId}
                                filter={filter}
                                onLoad={(q) => { onLoadSaved(q); onOpenChange(false) }}
                                onKeep={keep}
                                onMakeRule={makeRule}
                            />
                        )}
                        {tab === 'recipes' && (
                            <div className="flex flex-col gap-2">
                                {activeDraft && (
                                    <p className="px-1 text-2xs text-ink-muted">
                                        Picking a recipe replaces your current query.
                                    </p>
                                )}
                                <ViewRecipes viewId={viewId} filter={filter}
                                             onPick={(r) => { onPickRecipe(r); onOpenChange(false) }} />
                            </div>
                        )}
                    </div>
                    <input
                        ref={fileInput}
                        type="file"
                        accept=".json,application/json"
                        className="hidden"
                        aria-hidden
                        tabIndex={-1}
                        onChange={(e) => {
                            void openFile(e.target.files?.[0])
                            e.target.value = ''
                        }}
                    />
                    <LibraryFileActions
                        canExport={Boolean(libraryViewId)}
                        canImport={Boolean(libraryViewId) && canEdit}
                        exporting={exporting}
                        onOpenFile={() => fileInput.current?.click()}
                        onExport={() => void handleExport()}
                        onImport={() => {
                            // Close first so the dialog is the only
                            // modal layer visible (as Save as… does).
                            onOpenChange(false)
                            setImportOpen(true)
                        }}
                    />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
        {(importOpen || importPack) && libraryViewId && (
            <div className="contents" onKeyDown={keepKeysHere}>
                <LibraryImportDialog
                    viewId={libraryViewId}
                    branchId={branchId}
                    initialPack={importPack?.pack}
                    initialFileName={importPack?.fileName}
                    onClose={() => { setImportOpen(false); setImportPack(null) }}
                    onImported={(result) => { setImportPack(null); handleImported(result) }}
                />
            </div>
        )}
        </>
    )
}


// ---------------------------------------------------------------------------
// Footer — the view's library to a file, or a file into it
// ---------------------------------------------------------------------------

function LibraryFileActions({
    canExport, canImport, exporting, onOpenFile, onExport, onImport,
}: {
    canExport: boolean
    canImport: boolean
    exporting: boolean
    onOpenFile: () => void
    onExport: () => void
    onImport: () => void
}) {
    const button = cn(
        'inline-flex items-center gap-1.5 px-2 h-7 rounded-lg whitespace-nowrap',
        'text-[11px] font-medium text-ink-muted transition-colors',
        'hover:text-accent-lineage hover:bg-accent-lineage/10',
        'disabled:opacity-60 disabled:pointer-events-none',
    )
    return (
        <div className={cn(
            'flex items-center gap-1 px-3 py-2 shrink-0',
            'border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.03]',
        )}>
            <button
                type="button"
                onClick={onOpenFile}
                className={cn(button, 'mr-auto')}
                title="Run a query from a file: one downloaded from a library, or a search's JSON"
            >
                <FolderOpen className="w-3.5 h-3.5" />
                Open file…
            </button>
            {canExport && (
            <button
                type="button"
                onClick={onExport}
                disabled={exporting}
                className={button}
                title="Download this view's saved queries and display rules as a file"
            >
                {exporting
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Package className="w-3.5 h-3.5" />}
                Export library
            </button>
            )}
            {canImport && (
                <button
                    type="button"
                    onClick={onImport}
                    className={button}
                    title="Add saved queries and display rules from a library file"
                >
                    <Upload className="w-3.5 h-3.5" />
                    Import library…
                </button>
            )}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Header (search input + close)
// ---------------------------------------------------------------------------

function Header({
    filter, onFilterChange, onClose,
}: {
    filter: string
    onFilterChange: (v: string) => void
    onClose: () => void
}) {
    return (
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-glass-border/60">
            <SearchIcon className="w-3.5 h-3.5 text-ink-muted shrink-0" />
            <input
                type="text"
                autoFocus
                value={filter}
                onChange={(e) => onFilterChange(e.target.value)}
                placeholder="Filter your library…"
                className={cn(
                    'flex-1 min-w-0 bg-transparent outline-none',
                    'text-[12.5px] text-ink placeholder:text-ink-muted/60',
                )}
            />
            {filter && (
                <button
                    type="button"
                    onClick={() => onFilterChange('')}
                    className="text-ink-muted hover:text-ink"
                    aria-label="Clear filter"
                >
                    <X className="w-3 h-3" />
                </button>
            )}
            <button
                type="button"
                onClick={onClose}
                className={cn(
                    'inline-flex items-center justify-center w-6 h-6 rounded',
                    'text-ink-muted hover:text-ink hover:bg-glass/40',
                )}
                aria-label="Close library"
            >
                <X className="w-3.5 h-3.5" />
            </button>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Tab strip
// ---------------------------------------------------------------------------

function Tabs({
    tab, onChange, mineCount, sharedCount,
}: {
    tab: LibraryTab
    onChange: (t: LibraryTab) => void
    mineCount: number
    sharedCount: number
}) {
    return (
        <div className="flex items-center gap-1 px-3 pt-2 pb-1 border-b border-glass-border/40">
            <TabButton active={tab === 'mine'} onClick={() => onChange('mine')}>
                Mine
                {mineCount > 0 && <CountPill value={mineCount} />}
            </TabButton>
            <TabButton active={tab === 'shared'} onClick={() => onChange('shared')}>
                This view
                {sharedCount > 0 && <CountPill value={sharedCount} />}
            </TabButton>
            <TabButton active={tab === 'others'} onClick={() => onChange('others')}>
                Other views
            </TabButton>
            <TabButton active={tab === 'recipes'} onClick={() => onChange('recipes')}>
                Recipes
            </TabButton>
        </div>
    )
}


function TabButton({
    active, onClick, children,
}: {
    active: boolean
    onClick: () => void
    children: ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md',
                'text-[11.5px] font-semibold transition-colors',
                active
                    ? 'bg-accent-lineage/20 text-accent-lineage'
                    : 'text-ink-muted hover:text-ink',
            )}
        >
            {children}
        </button>
    )
}


function CountPill({ value }: { value: number }) {
    return (
        <span className="text-[10px] font-medium tabular-nums opacity-70">
            {value}
        </span>
    )
}


// ---------------------------------------------------------------------------
// Mine tab
// ---------------------------------------------------------------------------

/** A Mine entry as a query to keep or make a rule of. */
function mineQuery(entry: RecentQueryEntry): QueryToKeep {
    return { name: entry.name || entry.label || 'Saved query', description: entry.description ?? null,
             predicate: entry.predicate }
}


function MineTab({
    entries, filter, onLoad, onKeep, onMakeRule, onTogglePin, onRemove, onSaveAs,
}: {
    entries: ReadonlyArray<RecentQueryEntry>
    filter: string
    onLoad: (entry: RecentQueryEntry) => void
    onKeep: (entry: RecentQueryEntry) => void
    onMakeRule?: (entry: RecentQueryEntry) => void
    onTogglePin: (timestamp: number) => void
    onRemove: (timestamp: number) => void
    onSaveAs: (entry: RecentQueryEntry) => void
}) {
    const filtered = useMemo(() => {
        const q = filter.trim().toLowerCase()
        if (!q) return entries
        return entries.filter((e) => {
            const haystack = `${e.name ?? ''} ${e.label} ${e.description ?? ''}`.toLowerCase()
            return haystack.includes(q)
        })
    }, [entries, filter])

    if (entries.length === 0) {
        return (
            <EmptyState
                Icon={Star}
                title="Nothing saved yet"
                description="Run a query and pin it — or click Save as… on a recent entry to give it a name. Your saved queries will appear here for this view."
            />
        )
    }
    if (filtered.length === 0) {
        return (
            <div className="text-center text-[12px] text-ink-muted italic py-6">
                No saved queries match "{filter}".
            </div>
        )
    }
    return (
        <div className="flex flex-col gap-1">
            {filtered.map((entry) => (
                <MineRow
                    key={entry.timestamp}
                    entry={entry}
                    onLoad={() => onLoad(entry)}
                    onKeep={() => onKeep(entry)}
                    onMakeRule={onMakeRule && (() => onMakeRule(entry))}
                    onTogglePin={() => onTogglePin(entry.timestamp)}
                    onRemove={() => onRemove(entry.timestamp)}
                    onSaveAs={() => onSaveAs(entry)}
                />
            ))}
        </div>
    )
}


function MineRow({
    entry, onLoad, onKeep, onMakeRule, onTogglePin, onRemove, onSaveAs,
}: {
    entry: RecentQueryEntry
    onLoad: () => void
    onKeep: () => void
    onMakeRule?: () => void
    onTogglePin: () => void
    onRemove: () => void
    onSaveAs: () => void
}) {
    const isNamed = entry.source === 'mine' && Boolean(entry.name)
    const canShare = useLibraryCanEdit()
    // A Connections search reads as its ends, not as the JSON it is kept as.
    const connections = asDraft(entry.predicate).kind === 'edges'
    const label = connections ? queryLabel(entry.predicate) : entry.label
    const displayLabel = isNamed ? entry.name! : label || '(empty)'
    const truncated = displayLabel.length > 80
        ? displayLabel.slice(0, 77) + '…'
        : displayLabel
    return (
        <div
            className={cn(
                'group/row flex items-stretch gap-0 rounded-lg overflow-hidden',
                'bg-canvas-base/40 hover:bg-canvas-base/70',
                'border border-glass-border/60 hover:border-accent-lineage/40',
                'transition-colors',
            )}
        >
            <button
                type="button"
                onClick={onLoad}
                title={`Load: ${displayLabel}`}
                className="flex-1 min-w-0 flex flex-col items-start gap-0.5 px-3 py-2 text-left"
            >
                <div className="flex items-center gap-1.5 w-full min-w-0">
                    {isNamed ? (
                        <Star className="w-3 h-3 text-amber-400 shrink-0" fill="currentColor" />
                    ) : (
                        <SearchIcon className="w-3 h-3 text-ink-muted/70 shrink-0" />
                    )}
                    <span className={cn(
                        'text-[12px] truncate',
                        isNamed
                            ? 'font-display font-semibold text-ink'
                            : 'font-mono text-ink-secondary',
                    )}>
                        {truncated}
                    </span>
                    {connections && <ConnectionsBadge />}
                </div>
                {isNamed && entry.description && (
                    <span className="text-[10.5px] text-ink-muted truncate w-full pl-[18px]">
                        {entry.description}
                    </span>
                )}
                {isNamed && (
                    <span className="text-[10px] font-mono text-ink-muted/60 truncate w-full pl-[18px]">
                        {label}
                    </span>
                )}
            </button>
            <div className={cn(
                'flex items-stretch shrink-0',
                'opacity-0 group-hover/row:opacity-100 transition-opacity',
            )}>
                {!isNamed && (
                    <button
                        type="button"
                        onClick={onSaveAs}
                        title="Save with a name"
                        className={cn(
                            'inline-flex items-center justify-center w-7',
                            'text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/10',
                        )}
                        aria-label="Save with a name"
                    >
                        <BookmarkPlus className="w-3.5 h-3.5" />
                    </button>
                )}
                <KeepActions label={displayLabel} onKeep={onKeep} onMakeRule={onMakeRule}
                             refusal={connections ? NO_RULE_FOR_CONNECTIONS : undefined} />
                {isNamed && canShare && (
                    <button
                        type="button"
                        onClick={onSaveAs}
                        title="Share with everyone on this view"
                        className={cn(
                            'inline-flex items-center justify-center w-7',
                            'text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/10',
                        )}
                        aria-label="Share with everyone on this view"
                    >
                        <Users className="w-3.5 h-3.5" />
                    </button>
                )}
                <button
                    type="button"
                    onClick={onTogglePin}
                    title={entry.pinned ? 'Unpin (allow auto-eviction)' : 'Pin to keep'}
                    aria-pressed={entry.pinned}
                    className={cn(
                        'inline-flex items-center justify-center w-7',
                        entry.pinned
                            ? 'text-amber-400 hover:text-amber-300 opacity-100'
                            : 'text-ink-muted hover:text-amber-400',
                    )}
                >
                    {entry.pinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
                </button>
                <button
                    type="button"
                    onClick={onRemove}
                    title="Remove from library"
                    className={cn(
                        'inline-flex items-center justify-center w-7',
                        'text-ink-muted hover:text-rose-400 hover:bg-rose-500/10',
                    )}
                    aria-label="Remove"
                >
                    <Trash2 className="w-3 h-3" />
                </button>
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// This view's saved queries (the view's library, on the server)
// ---------------------------------------------------------------------------

function SharedTab({
    queries, filter, onLoad, onKeep, onMakeRule,
}: {
    queries: ReadonlyArray<SavedViewQuery>
    filter: string
    onLoad: (query: SavedViewQuery) => void
    onKeep: (query: SavedViewQuery) => void
    onMakeRule?: (query: SavedViewQuery) => void
}) {
    const loading = useViewLibraryStore((s) => s.status === 'loading')
    const canEdit = useLibraryCanEdit()
    const removeQuery = useViewLibraryStore((s) => s.removeQuery)
    const { notify } = useAppNotifications()

    const filtered = useMemo(() => {
        const q = filter.trim().toLowerCase()
        if (!q) return queries
        return queries.filter((e) => `${e.name} ${e.description ?? ''}`.toLowerCase().includes(q))
    }, [queries, filter])

    if (queries.length === 0 && loading) {
        return (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-ink-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading this view's queries…
            </div>
        )
    }
    if (queries.length === 0) {
        return (
            <EmptyState
                Icon={Users}
                title="No queries saved in this view yet"
                description={canEdit
                    ? 'Save a query for everyone who opens this view: use Save on the query card, or share one of yours from Mine.'
                    : 'People who can edit this view can save queries here for everyone who opens it.'}
            />
        )
    }
    if (filtered.length === 0) {
        return (
            <div className="text-center text-[12px] text-ink-muted italic py-6">
                No saved queries match "{filter}".
            </div>
        )
    }
    return (
        <div className="flex flex-col gap-1">
            {filtered.map((query) => (
                <SavedRow
                    key={query.id}
                    query={query}
                    canEdit={canEdit}
                    onLoad={() => onLoad(query)}
                    onKeep={() => onKeep(query)}
                    onMakeRule={onMakeRule && (() => onMakeRule(query))}
                    onRemove={() => {
                        removeQuery(query.id).catch((e: Error) =>
                            notify('error', `Couldn't remove “${query.name}” — ${e.message}`))
                    }}
                />
            ))}
        </div>
    )
}


function SavedRow({
    query, canEdit, onLoad, onKeep, onMakeRule, onRemove,
}: {
    query: SavedViewQuery
    canEdit: boolean
    onLoad: () => void
    onKeep: () => void
    onMakeRule?: () => void
    onRemove: () => void
}) {
    // Removing a query removes it for everyone: the first click asks.
    const [confirming, setConfirming] = useState(false)
    const dsl = useMemo(() => queryLabel(query.predicate), [query.predicate])
    const connections = asDraft(query.predicate).kind === 'edges'
    return (
        <div
            className={cn(
                'group/row flex items-stretch gap-0 rounded-lg overflow-hidden',
                'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
                'border border-glass-border hover:border-accent-lineage/40',
                'transition-colors',
            )}
            onMouseLeave={() => setConfirming(false)}
        >
            <button
                type="button"
                onClick={onLoad}
                title={`Load: ${query.name}`}
                className="flex-1 min-w-0 flex flex-col items-start gap-0.5 px-3 py-2 text-left"
            >
                <div className="flex items-center gap-1.5 w-full min-w-0">
                    <Users className="w-3 h-3 text-accent-lineage shrink-0" />
                    <span className="text-[12px] truncate font-display font-semibold text-ink">
                        {query.name}
                    </span>
                    {connections && <ConnectionsBadge />}
                </div>
                {query.description && (
                    <span className="text-[10.5px] text-ink-muted truncate w-full pl-[18px]">
                        {query.description}
                    </span>
                )}
                <span className="text-[10px] font-mono text-ink-muted truncate w-full pl-[18px]">
                    {dsl}
                </span>
            </button>
            <div className={cn(
                'flex items-stretch shrink-0 transition-opacity',
                confirming ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-within:opacity-100',
            )}>
                {!confirming && <KeepActions label={query.name} onKeep={onKeep} onMakeRule={onMakeRule}
                                             refusal={connections ? NO_RULE_FOR_CONNECTIONS : undefined} />}
                {canEdit && (confirming ? (
                        <button
                            type="button"
                            onClick={onRemove}
                            className="px-2 text-[10.5px] font-semibold text-rose-400 hover:bg-rose-500/10"
                        >
                            Remove for everyone
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setConfirming(true)}
                            title="Remove from this view"
                            aria-label={`Remove “${query.name}” from this view`}
                            className={cn(
                                'inline-flex items-center justify-center w-7',
                                'text-ink-muted hover:text-rose-400 hover:bg-rose-500/10',
                            )}
                        >
                            <Trash2 className="w-3 h-3" />
                        </button>
                    ))}
            </div>
        </div>
    )
}


/** Marks a saved Connections search: it finds edges, not entities. */
function ConnectionsBadge() {
    return (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-accent-lineage/12 px-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-accent-lineage">
            <Waypoints className="h-2.5 w-2.5" aria-hidden /> Connections
        </span>
    )
}


/** Download a saved query as a file, and — for someone who can edit the
 *  view — make a display rule of it, unless it can make none (``refusal``
 *  says why). */
function KeepActions({ label, onKeep, onMakeRule, refusal }: {
    label: string
    onKeep: () => void
    onMakeRule?: () => void
    refusal?: string
}) {
    const action = cn(
        'inline-flex items-center justify-center w-7',
        'text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/10',
        'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted',
    )
    return (
        <>
            {onMakeRule && (
                <button type="button" onClick={onMakeRule} className={action} disabled={!!refusal}
                        title={refusal ?? 'Make a display rule of it — tag every entity it matches'}
                        aria-label={`Make a display rule of “${label}”`}>
                    <Tags className="w-3.5 h-3.5" />
                </button>
            )}
            <button type="button" onClick={onKeep} className={action}
                    title="Download it as a file — open it in any view, or import it into one"
                    aria-label={`Download “${label}”`}>
                <ArrowDownToLine className="w-3.5 h-3.5" />
            </button>
        </>
    )
}


// ---------------------------------------------------------------------------
// Other views — the workspace's other views' saved queries, and the user's
// own saved on other views
// ---------------------------------------------------------------------------

function OthersTab({
    viewId, filter, onLoad, onKeep, onMakeRule,
}: {
    viewId: string
    filter: string
    onLoad: (query: SavedViewQuery) => void
    onKeep: (query: QueryToKeep, from: { viewId: string; viewName?: string | null }) => void
    onMakeRule?: (query: QueryToKeep) => void
}) {
    const [found, setFound] = useState<{ items: OtherViewQuery[]; error?: string } | null>(null)
    useEffect(() => {
        const controller = new AbortController()
        listQueriesFromOtherViews(viewId, controller.signal)
            .then((items) => setFound({ items }))
            .catch((e: Error) => { if (!controller.signal.aborted) setFound({ items: [], error: e.message }) })
        return () => controller.abort()
    }, [viewId])

    // The user's own, saved (named) on another view, in this browser.
    const recent = useSearchStore((s) => s.recentQueries)
    const mine = useMemo(
        () => recent.filter((e) => e.source === 'mine' && e.name && e.viewId !== viewId),
        [recent, viewId],
    )

    const q = filter.trim().toLowerCase()
    // In the order the server gave them, one group per view.
    const groups = useMemo(() => {
        const out: { viewId: string; viewName: string; sameSource: boolean; items: OtherViewQuery[] }[] = []
        for (const item of found?.items ?? []) {
            if (q && !`${item.query.name} ${item.query.description ?? ''} ${item.viewName}`.toLowerCase().includes(q)) continue
            const last = out[out.length - 1]
            if (last?.viewId === item.viewId) last.items.push(item)
            else out.push({ viewId: item.viewId, viewName: item.viewName, sameSource: item.sameSource, items: [item] })
        }
        return out
    }, [found, q])
    const viewNames = useMemo(
        () => new Map((found?.items ?? []).map((i) => [i.viewId, i.viewName])), [found])
    const myOwn = mine.filter((e) => !q || `${e.name} ${e.description ?? ''}`.toLowerCase().includes(q))

    if (!found && !mine.length) {
        return (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-ink-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Looking through the other views…
            </div>
        )
    }
    if (!groups.length && !myOwn.length) {
        if (q && ((found?.items.length ?? 0) > 0 || mine.length > 0)) {
            return <div className="text-center text-[12px] text-ink-muted italic py-6">No saved queries match "{filter}".</div>
        }
        return (
            <EmptyState
                Icon={LayoutGrid}
                title={found?.error ? "Couldn't look through the other views" : 'Nothing saved on other views yet'}
                description={found?.error
                    ?? 'Queries saved on the other views of this workspace that you can open show here, to run in this one.'}
            />
        )
    }
    return (
        <div className="flex flex-col gap-3">
            {myOwn.length > 0 && (
                <OtherGroup title="Yours, saved on other views">
                    {myOwn.map((entry) => {
                        const from = { viewId: entry.viewId, viewName: viewNames.get(entry.viewId) ?? null }
                        const query = mineQuery(entry)
                        return (
                            <OtherRow key={entry.timestamp} query={query} from={from.viewName ?? 'another view'} mine
                                      onLoad={() => onLoad({ id: `mine:${entry.timestamp}`, ...query })}
                                      onKeep={() => onKeep(query, from)}
                                      onMakeRule={onMakeRule && (() => onMakeRule(query))} />
                        )
                    })}
                </OtherGroup>
            )}
            {groups.map((g) => (
                <OtherGroup key={g.viewId} title={g.viewName}
                            note={g.sameSource ? undefined : 'Another data source — its names and types may differ here'}>
                    {g.items.map((item) => (
                        <OtherRow key={item.query.id} query={{ ...item.query, description: item.query.description ?? null }}
                                  from={item.viewName}
                                  onLoad={() => onLoad(item.query)}
                                  onKeep={() => onKeep(item.query, { viewId: item.viewId, viewName: item.viewName })}
                                  onMakeRule={onMakeRule && (() => onMakeRule(item.query))} />
                    ))}
                </OtherGroup>
            ))}
        </div>
    )
}


function OtherGroup({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2 px-1">
                <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-muted truncate">{title}</h3>
                {note && <span className="text-[10px] text-amber-600 dark:text-amber-400/90 truncate">{note}</span>}
            </div>
            {children}
        </section>
    )
}


/** A query from elsewhere: run it here, copy it into this view's library
 *  (someone who can edit it), make a rule of it, or download it. */
function OtherRow({ query, from, mine = false, onLoad, onKeep, onMakeRule }: {
    query: QueryToKeep
    from: string
    mine?: boolean
    onLoad: () => void
    onKeep: () => void
    onMakeRule?: () => void
}) {
    const canEdit = useLibraryCanEdit()
    const saveQuery = useViewLibraryStore((s) => s.saveQuery)
    const { notify } = useAppNotifications()
    const [copying, setCopying] = useState(false)
    const dsl = useMemo(() => queryLabel(query.predicate), [query.predicate])
    const connections = asDraft(query.predicate).kind === 'edges'

    // Copied under its own name — or, when this view has a query by that
    // name, under one that says where it came from.
    const copy = async () => {
        setCopying(true)
        const body = { name: query.name, description: query.description ?? null, predicate: query.predicate }
        try {
            try {
                await saveQuery(body)
            } catch (e) {
                if (httpStatusOf(e) !== 409) throw e
                await saveQuery({ ...body, name: `${query.name} (from ${from})`.slice(0, 120) })
            }
            notify('success', `“${query.name}” is saved in this view now`)
        } catch (e) {
            notify('error', `Couldn't copy “${query.name}” — ${(e as Error).message}`)
        } finally {
            setCopying(false)
        }
    }

    return (
        <div className={cn(
            'group/row flex items-stretch gap-0 rounded-lg overflow-hidden',
            'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
            'border border-glass-border hover:border-accent-lineage/40',
            'transition-colors',
        )}>
            <button
                type="button"
                onClick={onLoad}
                title={`Run it here: ${query.name}`}
                className="flex-1 min-w-0 flex flex-col items-start gap-0.5 px-3 py-2 text-left"
            >
                <div className="flex items-center gap-1.5 w-full min-w-0">
                    {mine
                        ? <Star className="w-3 h-3 text-amber-400 shrink-0" fill="currentColor" />
                        : <LayoutGrid className="w-3 h-3 text-accent-lineage shrink-0" />}
                    <span className="text-[12px] truncate font-display font-semibold text-ink">{query.name}</span>
                    {connections && <ConnectionsBadge />}
                </div>
                {query.description && (
                    <span className="text-[10.5px] text-ink-muted truncate w-full pl-[18px]">{query.description}</span>
                )}
                <span className="text-[10px] font-mono text-ink-muted truncate w-full pl-[18px]">{dsl}</span>
            </button>
            <div className="flex items-stretch shrink-0 transition-opacity opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
                {canEdit && (
                    <button type="button" onClick={() => void copy()} disabled={copying}
                            title="Save a copy in this view's library, for everyone who opens it"
                            aria-label={`Copy “${query.name}” to this view`}
                            className={cn(
                                'inline-flex items-center justify-center w-7 disabled:opacity-60',
                                'text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/10',
                            )}>
                        {copying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CopyPlus className="w-3.5 h-3.5" />}
                    </button>
                )}
                <KeepActions label={query.name} onKeep={onKeep} onMakeRule={onMakeRule}
                             refusal={connections ? NO_RULE_FOR_CONNECTIONS : undefined} />
            </div>
        </div>
    )
}


function EmptyState({
    Icon, title, description,
}: {
    Icon: typeof Star
    title: string
    description: string
}) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="flex flex-col items-center justify-center gap-3 py-10 px-6 text-center"
        >
            <div className={cn(
                'w-12 h-12 rounded-2xl flex items-center justify-center',
                'bg-gradient-to-br from-accent-lineage/15 to-cyan-500/10',
                'border border-glass-border/40',
            )}>
                <Icon className="w-5 h-5 text-accent-lineage" />
            </div>
            <div className="space-y-1">
                <div className="text-[13px] font-display font-semibold text-ink">
                    {title}
                </div>
                <p className="text-[11.5px] text-ink-muted max-w-[280px]">
                    {description}
                </p>
            </div>
        </motion.div>
    )
}


