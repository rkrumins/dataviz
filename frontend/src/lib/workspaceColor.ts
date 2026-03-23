/**
 * Deterministic workspace color — assigns a consistent color to each
 * workspace based on a hash of its ID. Users visually learn that
 * "blue = Sales, green = Engineering" without needing to read labels.
 */

const WORKSPACE_COLORS = [
  { bg: 'bg-blue-500/15', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-500/30' },
  { bg: 'bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400', border: 'border-emerald-500/30' },
  { bg: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400', border: 'border-amber-500/30' },
  { bg: 'bg-violet-500/15', text: 'text-violet-600 dark:text-violet-400', border: 'border-violet-500/30' },
  { bg: 'bg-rose-500/15', text: 'text-rose-600 dark:text-rose-400', border: 'border-rose-500/30' },
  { bg: 'bg-teal-500/15', text: 'text-teal-600 dark:text-teal-400', border: 'border-teal-500/30' },
  { bg: 'bg-orange-500/15', text: 'text-orange-600 dark:text-orange-400', border: 'border-orange-500/30' },
  { bg: 'bg-cyan-500/15', text: 'text-cyan-600 dark:text-cyan-400', border: 'border-cyan-500/30' },
  { bg: 'bg-pink-500/15', text: 'text-pink-600 dark:text-pink-400', border: 'border-pink-500/30' },
  { bg: 'bg-indigo-500/15', text: 'text-indigo-600 dark:text-indigo-400', border: 'border-indigo-500/30' },
] as const

export type WorkspaceColorSet = typeof WORKSPACE_COLORS[number]

function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

/**
 * Get a deterministic color set for a workspace.
 * Returns Tailwind class names for bg, text, and border.
 */
export function workspaceColor(workspaceId: string): WorkspaceColorSet {
  const index = simpleHash(workspaceId) % WORKSPACE_COLORS.length
  return WORKSPACE_COLORS[index]
}
