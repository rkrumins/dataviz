/**
 * LibraryPopover — unified discovery surface for search queries.
 *
 * Replaces the old ``TemplatesStrip`` which had three tabs
 * (Quick starts / Browse all / Recent) buried behind an unlabeled icon.
 * This popover has three tabs:
 *
 *   Mine       — user-saved queries (promoted from Recent via "Save as…")
 *                + pinned recents. Per-user, localStorage-backed.
 *   Shared     — team-shared queries (backend follow-up). Empty state
 *                today with a permission-gated "Suggest a query" CTA
 *                so the UX is ready when the backend lands.
 *   Templates  — built-in starter queries. The "Featured" subset
 *                (previously "Quick starts") shows as chips at the top;
 *                the full TemplatePicker sits below.
 *
 * A single text input filters across all three tabs simultaneously so
 * the user can ask "do I have anything saved about PII?" without
 * remembering whether they saved it themselves, a teammate did, or
 * it's a built-in template.
 */
import * as Popover from '@radix-ui/react-popover'
import { motion } from 'framer-motion'
import {
    BookmarkPlus, Pin, PinOff, Search as SearchIcon, Sparkles,
    Star, Trash2, Users, X,
} from 'lucide-react'
import { type FC, type ReactNode, useMemo, useState } from 'react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { cn } from '@/lib/utils'
import type { RecentQueryEntry } from '@/store/searchStore'
import { useAuthStore } from '@/store/auth'

import { TemplatePicker } from '../TemplatePicker'
import {
    featuredTemplates,
    type SearchTemplate,
} from '../searchTemplates'


type LibraryTab = 'mine' | 'shared' | 'templates'


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
    /** Seed the QueryCard from a template. Closes the popover. */
    onSeedTemplate: (template: SearchTemplate) => void
    /** Load a saved/recent query into the QueryCard. Closes the popover. */
    onLoadRecent: (entry: RecentQueryEntry) => void
    /** Toggle the pin state of a recent entry. */
    onTogglePinRecent: (timestamp: number) => void
    /** Remove a recent entry. */
    onRemoveRecent: (timestamp: number) => void
    /** Open the Save-as dialog for the given recent entry. The dialog
     *  itself is owned by SearchMapPanel so it survives popover close
     *  — when the dialog mounts, the popover dismisses naturally
     *  (and the dialog keeps rendering at viewport level via its own
     *  portal). */
    onSaveAs: (entry: RecentQueryEntry) => void
    /** The view this panel is bound to. Used for the Shared tab's
     *  permission gate. */
    viewId: string
    /** Whether the active draft has filters — affects template-seed
     *  copy ("template will REPLACE current filters"). */
    activeDraft: boolean
}


export const LibraryPopover: FC<LibraryPopoverProps> = ({
    children, open, onOpenChange,
    recentQueries, onSeedTemplate, onLoadRecent, onTogglePinRecent,
    onRemoveRecent, onSaveAs, viewId, activeDraft,
}) => {
    // Default to Mine when the user has anything saved/pinned; fall
    // back to Templates on first session so the popover isn't empty.
    const [tab, setTab] = useState<LibraryTab>(
        recentQueries.length > 0 ? 'mine' : 'templates',
    )
    const [filter, setFilter] = useState('')

    const featured = useMemo(() => featuredTemplates(), [])

    return (
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
                    className={cn(
                        'w-[420px] max-h-[70vh] rounded-xl overflow-hidden',
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
                    />
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3">
                        {tab === 'mine' && (
                            <MineTab
                                entries={recentQueries}
                                filter={filter}
                                onLoad={(e) => { onLoadRecent(e); onOpenChange(false) }}
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
                            <SharedTab viewId={viewId} />
                        )}
                        {tab === 'templates' && (
                            <TemplatesTab
                                featured={featured}
                                filter={filter}
                                activeDraft={activeDraft}
                                onSeed={(t) => { onSeedTemplate(t); onOpenChange(false) }}
                            />
                        )}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
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
    tab, onChange, mineCount,
}: {
    tab: LibraryTab
    onChange: (t: LibraryTab) => void
    mineCount: number
}) {
    return (
        <div className="flex items-center gap-1 px-3 pt-2 pb-1 border-b border-glass-border/40">
            <TabButton active={tab === 'mine'} onClick={() => onChange('mine')}>
                Mine
                {mineCount > 0 && <CountPill value={mineCount} />}
            </TabButton>
            <TabButton active={tab === 'shared'} onClick={() => onChange('shared')}>
                Shared
            </TabButton>
            <TabButton active={tab === 'templates'} onClick={() => onChange('templates')}>
                Templates
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

function MineTab({
    entries, filter, onLoad, onTogglePin, onRemove, onSaveAs,
}: {
    entries: ReadonlyArray<RecentQueryEntry>
    filter: string
    onLoad: (entry: RecentQueryEntry) => void
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
                    onTogglePin={() => onTogglePin(entry.timestamp)}
                    onRemove={() => onRemove(entry.timestamp)}
                    onSaveAs={() => onSaveAs(entry)}
                />
            ))}
        </div>
    )
}


function MineRow({
    entry, onLoad, onTogglePin, onRemove, onSaveAs,
}: {
    entry: RecentQueryEntry
    onLoad: () => void
    onTogglePin: () => void
    onRemove: () => void
    onSaveAs: () => void
}) {
    const isNamed = entry.source === 'mine' && Boolean(entry.name)
    const displayLabel = isNamed ? entry.name! : entry.label || '(empty)'
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
                </div>
                {isNamed && entry.description && (
                    <span className="text-[10.5px] text-ink-muted truncate w-full pl-[18px]">
                        {entry.description}
                    </span>
                )}
                {isNamed && (
                    <span className="text-[10px] font-mono text-ink-muted/60 truncate w-full pl-[18px]">
                        {entry.label}
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
// Shared tab (empty state — backend follow-up)
// ---------------------------------------------------------------------------

function SharedTab({ viewId }: { viewId: string }) {
    // Permission gate is informational today — the backend doesn't
    // exist yet. When it lands, this exact check decides who can
    // promote a Mine entry into the team library. Using ``can()``
    // directly with the view's workspace context would require a
    // viewId → workspaceId lookup; for the empty-state CTA the
    // current-workspace check is a reasonable proxy.
    const can = useAuthStore((s) => s.can)
    // ``workspace:view:edit`` is the seed permission the backend
    // task will read from. We pass ``undefined`` for workspaceId
    // here so the check is global-scoped — wired properly when the
    // backend resource arrives. (See `view_execution_context`
    // memory for the view-vs-workspace decoupling rationale.)
    void viewId  // intentionally unused until backend lands
    const canSuggest = can('workspace:view:edit')

    return (
        <div className="flex flex-col items-center justify-center gap-3 py-10 px-6 text-center">
            <div className={cn(
                'w-12 h-12 rounded-2xl flex items-center justify-center',
                'bg-gradient-to-br from-accent-lineage/20 to-cyan-500/15',
                'border border-glass-border/40',
            )}>
                <Users className="w-5 h-5 text-accent-lineage" />
            </div>
            <div className="space-y-1">
                <div className="text-[13px] font-display font-semibold text-ink">
                    Team-shared queries coming soon
                </div>
                <p className="text-[11.5px] text-ink-muted max-w-[280px]">
                    Once enabled, queries saved to the shared library will be
                    discoverable by everyone on this view — with author and
                    editor permissions kept in sync with the rest of the
                    workspace.
                </p>
            </div>
            <button
                type="button"
                disabled={!canSuggest}
                title={canSuggest
                    ? 'Submit feedback for the team-shared queries feature'
                    : 'You need edit permission on this view to suggest queries'}
                className={cn(
                    'inline-flex items-center gap-1.5 px-3 h-7 rounded-md',
                    'text-[11.5px] font-medium transition-colors',
                    canSuggest
                        ? 'bg-accent-lineage/15 text-accent-lineage hover:bg-accent-lineage/25'
                        : 'bg-glass/40 text-ink-muted/60 cursor-not-allowed',
                )}
            >
                <Sparkles className="w-3 h-3" />
                Suggest a query
            </button>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Templates tab
// ---------------------------------------------------------------------------

function TemplatesTab({
    featured, filter, activeDraft, onSeed,
}: {
    featured: ReadonlyArray<SearchTemplate>
    filter: string
    activeDraft: boolean
    onSeed: (template: SearchTemplate) => void
}) {
    const filteredFeatured = useMemo(() => {
        const q = filter.trim().toLowerCase()
        if (!q) return featured
        return featured.filter((t) => {
            const haystack = `${t.label} ${t.chipLabel ?? ''} ${t.description ?? ''}`.toLowerCase()
            return haystack.includes(q)
        })
    }, [featured, filter])

    return (
        <div className="flex flex-col gap-3">
            {/* Featured (formerly "Quick starts") — now visually grouped
                under the same heading as the rest of the browse list so
                it doesn't feel like a separate, half-integrated thing. */}
            <section className="space-y-2">
                <SectionHeading label="Featured" />
                {filteredFeatured.length === 0 ? (
                    <div className="text-center text-[11.5px] text-ink-muted italic py-3">
                        No featured templates match "{filter}".
                    </div>
                ) : (
                    <div className="flex flex-wrap gap-1.5">
                        {filteredFeatured.map((t) => (
                            <FeaturedChip
                                key={t.id}
                                template={t}
                                onClick={() => onSeed(t)}
                            />
                        ))}
                    </div>
                )}
                {activeDraft && (
                    <p className="text-[10.5px] text-ink-muted/70 leading-snug">
                        Picking a template replaces your current filters.
                    </p>
                )}
            </section>

            <section className="space-y-2">
                <SectionHeading label="All templates" />
                <TemplatePicker onPick={onSeed} />
            </section>
        </div>
    )
}


function FeaturedChip({
    template, onClick,
}: {
    template: SearchTemplate
    onClick: () => void
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={template.description}
            className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl',
                'text-[11.5px] font-medium',
                'bg-canvas-base/50 border border-glass-border',
                'text-ink-secondary hover:text-ink hover:border-accent-lineage/40',
                'hover:bg-accent-lineage/10 transition-all',
                'active:scale-95',
            )}
        >
            <DynamicIcon name={template.icon} className="w-3.5 h-3.5 text-accent-lineage" />
            {template.chipLabel ?? template.label}
        </button>
    )
}


function SectionHeading({ label }: { label: string }) {
    return (
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted/80">
            {label}
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


