/**
 * Shared view utilities — used across BookmarksPopover, Workspace Glance,
 * EnvironmentSwitcher, and Command Palette components.
 *
 * Extracted from SidebarNav.tsx to avoid duplication.
 */
import * as LucideIcons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ── Sidebar Workspace Avatar Gradient Colors ──────────────────────────
export const WS_GRADIENT_COLORS = [
  'from-indigo-500 to-violet-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-cyan-500 to-blue-500',
  'from-fuchsia-500 to-purple-500',
]

/** Deterministic gradient class for workspace avatars by index. */
export function wsGradient(index: number): string {
  return WS_GRADIENT_COLORS[index % WS_GRADIENT_COLORS.length]
}

// ── View Type → Lucide Icon Name Mapping ──────────────────────────────

const VIEW_TYPE_ICON_MAP: Record<string, string> = {
  graph: 'Network',
  hierarchy: 'GitBranch',
  tree: 'GitBranch',
  reference: 'Layers',
  'layered-lineage': 'AlignLeft',
  list: 'List',
  grid: 'LayoutGrid',
  timeline: 'Clock',
}

/** Maps a view layout type to its corresponding Lucide icon name. */
export function layoutTypeIcon(viewType: string): string {
  return VIEW_TYPE_ICON_MAP[viewType] ?? 'Layout'
}

/**
 * Resolves the icon to render for a view: the user's chosen icon wins only
 * when it differs from the 'Layout' default — every legacy view stores
 * 'Layout' (createView/viewToViewConfig default), so treating it as "no
 * choice" preserves type-derived icons except where a user deliberately
 * picked one in the wizard/editor.
 */
export function resolveViewIcon(opts: { icon?: string | null; viewType?: string | null }): string {
  return opts.icon && opts.icon !== 'Layout' ? opts.icon : layoutTypeIcon(opts.viewType ?? '')
}

// ── View Type Colors (matching ExplorerViewCard.tsx) ──────────────────

const VIEW_TYPE_COLORS: Record<string, string> = {
  graph: 'text-indigo-500',
  hierarchy: 'text-violet-500',
  tree: 'text-violet-500',
  reference: 'text-rose-500',
  'layered-lineage': 'text-amber-500',
  list: 'text-emerald-500',
  grid: 'text-emerald-500',
  table: 'text-emerald-500',
  timeline: 'text-cyan-500',
}

/** Returns a Tailwind text-color class for the view type. */
export function viewTypeColor(viewType: string): string {
  return VIEW_TYPE_COLORS[viewType] ?? 'text-ink-muted'
}

// ── View Type Theme — SINGLE SOURCE OF TRUTH ──────────────────────────
//
// Every Explorer surface (grid card, list row, recents strip, hero, preview
// drawer) MUST resolve a view's icon and colour identically. Each component
// previously kept its OWN type→icon/colour map, which is exactly how the
// "Continue where you left off" strip ended up rendering a purple Network icon
// for the same view the grid showed as a rose "Context View": the strip's map
// had no ``reference`` entry and fell through to its default, and it never
// called ``resolveViewIcon`` so a user's chosen ``config.icon`` was ignored too.
//
// Consume this together with ``resolveViewIcon`` + ``DynamicIcon``:
//   const iconName = resolveViewIcon({ icon: view.config?.icon, viewType: view.viewType })
//   const meta     = viewTypeMeta(view.viewType)

export interface ViewTypeMeta {
  label: string
  /**
   * One sentence saying what this KIND of view is, for a reader who has met
   * the words "Context View" and does not know what makes one different from
   * a Graph. Lives here beside the label because the label is useless without
   * it and the two must never disagree; the wizard's layout cards say the same
   * thing at length, this is the hover-sized version.
   *
   * Active voice, no trailing full stop — the tooltip copy rule.
   */
  what: string
  /** Icon-chip classes: background + border + icon colour, together. */
  iconBg: string
  hoverBorder: string
  gradient: string
}

const VIEW_TYPE_META: Record<string, ViewTypeMeta> = {
  graph: {
    label: 'Graph',
    what: 'Entities and their relationships, positioned freely — for exploring how things connect',
    iconBg: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500',
    hoverBorder: 'group-hover:border-indigo-500/30',
    gradient: 'bg-gradient-to-br from-indigo-500/[0.04] via-transparent to-transparent',
  },
  hierarchy: {
    label: 'Hierarchy',
    what: 'Entities nested inside their parents, as a tree you expand and collapse',
    iconBg: 'bg-violet-500/10 border-violet-500/20 text-violet-500',
    hoverBorder: 'group-hover:border-violet-500/30',
    gradient: 'bg-gradient-to-br from-violet-500/[0.04] via-transparent to-transparent',
  },
  table: {
    label: 'Table',
    what: 'One row per entity, with its properties as columns',
    iconBg: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500',
    hoverBorder: 'group-hover:border-emerald-500/30',
    gradient: 'bg-gradient-to-br from-emerald-500/[0.04] via-transparent to-transparent',
  },
  'layered-lineage': {
    label: 'Lineage',
    what: 'Data flowing left to right, one column per stage of its journey',
    iconBg: 'bg-amber-500/10 border-amber-500/20 text-amber-500',
    hoverBorder: 'group-hover:border-amber-500/30',
    gradient: 'bg-gradient-to-br from-amber-500/[0.04] via-transparent to-transparent',
  },
  reference: {
    label: 'Context View',
    what: 'Entities sorted into columns you define, with lineage drawn between them — the layout built for reading a pipeline',
    iconBg: 'bg-rose-500/10 border-rose-500/20 text-rose-500',
    hoverBorder: 'group-hover:border-rose-500/30',
    gradient: 'bg-gradient-to-br from-rose-500/[0.04] via-transparent to-transparent',
  },
}

const DEFAULT_VIEW_TYPE_META: ViewTypeMeta = {
  label: 'View',
  what: 'A saved way of looking at this data',
  iconBg: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500',
  hoverBorder: 'group-hover:border-indigo-500/30',
  gradient: 'bg-gradient-to-br from-indigo-500/[0.04] via-transparent to-transparent',
}

/** Canonical label + colour theme for a view type. Never define a local copy. */
export function viewTypeMeta(viewType?: string | null): ViewTypeMeta {
  return VIEW_TYPE_META[viewType ?? ''] ?? DEFAULT_VIEW_TYPE_META
}

/**
 * Human label for a view OR layout type.
 *
 * Layout types share the view-type vocabulary (`reference`, `layered-lineage`,
 * …), so a raw slug rendered with CSS `capitalize` produced "Reference" in the
 * preview drawer's Layout field while the View Type field right next to it said
 * "Context View" — the same thing, named two different ways. Resolve both
 * through here so they always agree.
 *
 * An unrecognised type degrades to a prettified slug ("layered-lineage" →
 * "Layered Lineage") rather than the generic "View" fallback, so a future
 * layout engine name still reads sensibly.
 */
export function viewTypeLabel(type?: string | null): string {
  if (!type) return 'Default'
  const known = VIEW_TYPE_META[type]
  if (known) return known.label
  return type
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// ── Dynamic Icon Component ────────────────────────────────────────────

/** Renders a Lucide icon by string name. Falls back to Layout icon. */
export function DynamicIcon({ name, className }: { name: string; className?: string }) {
  const IconComponent = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name]
  if (!IconComponent) return <LucideIcons.Layout className={className} />
  return <IconComponent className={className} />
}

/**
 * The canonical icon for a view type as a *component*, for APIs that want one
 * rather than a name (e.g. the filter bar's `FilterOption.icon: LucideIcon`).
 * Returns the Lucide component itself, so identity is stable across renders.
 */
export function viewTypeIconComponent(viewType?: string | null): LucideIcon {
  const name = layoutTypeIcon(viewType ?? '')
  const icon = (LucideIcons as unknown as Record<string, LucideIcon>)[name]
  return icon ?? LucideIcons.Layout
}
