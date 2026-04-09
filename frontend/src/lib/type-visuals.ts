/**
 * Type Visuals — deterministic visual fallbacks for unknown entity/edge types.
 *
 * When the schema store has no definition for a type (e.g., a custom ontology
 * introduces types the frontend hasn't seen before), these functions generate
 * stable, visually distinct colors and icons from the type name string.
 *
 * Pure functions — no React dependencies. Safe to call from hooks, canvas
 * renderers, workers, or tests.
 */

// -----------------------------------------------------------------------
// Curated palette — 16 perceptually distinct colors (Tailwind -500 inspired)
// -----------------------------------------------------------------------

const TYPE_COLOR_PALETTE = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#6366f1', // indigo
  '#14b8a6', // teal
  '#f97316', // orange
  '#84cc16', // lime
  '#a855f7', // purple
  '#0ea5e9', // sky
  '#22c55e', // green
  '#e11d48', // rose
  '#64748b', // slate
]

// -----------------------------------------------------------------------
// Curated icon set — 12 generic Lucide icon names
// -----------------------------------------------------------------------

const TYPE_ICON_SET = [
  'Box',
  'Database',
  'Table2',
  'Layers',
  'Workflow',
  'LayoutDashboard',
  'Server',
  'Package',
  'FolderOpen',
  'Columns3',
  'GitBranch',
  'Network',
]

// -----------------------------------------------------------------------
// Hash function (djb2 variant — matches workspaceColor.ts)
// -----------------------------------------------------------------------

export function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Generate a deterministic hex color from a type ID string.
 * Same input always produces the same color.
 */
export function generateColorFromType(typeId: string): string {
  const index = hashString(typeId) % TYPE_COLOR_PALETTE.length
  return TYPE_COLOR_PALETTE[index]
}

/**
 * Generate a deterministic Lucide icon name from a type ID string.
 * Returns a string that can be passed to DynamicIcon.
 */
export function generateIconFallback(typeId: string): string {
  const index = hashString(typeId) % TYPE_ICON_SET.length
  return TYPE_ICON_SET[index]
}

/**
 * Generate a deterministic color for an edge type.
 * Uses the same palette as entity types.
 */
export function generateEdgeColorFromType(edgeTypeId: string): string {
  return generateColorFromType(edgeTypeId.toUpperCase())
}
