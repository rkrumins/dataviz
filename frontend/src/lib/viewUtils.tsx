/**
 * Shared view utilities — used across BookmarksPopover, Workspace Glance,
 * EnvironmentSwitcher, and Command Palette components.
 *
 * Extracted from SidebarNav.tsx to avoid duplication.
 */
import * as LucideIcons from 'lucide-react'

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

// ── Dynamic Icon Component ────────────────────────────────────────────

/** Renders a Lucide icon by string name. Falls back to Layout icon. */
export function DynamicIcon({ name, className }: { name: string; className?: string }) {
  const IconComponent = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name]
  if (!IconComponent) return <LucideIcons.Layout className={className} />
  return <IconComponent className={className} />
}
