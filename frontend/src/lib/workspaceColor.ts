/**
 * Deterministic workspace color — assigns a consistent color to each
 * workspace based on a hash of its ID. Users visually learn that
 * "blue = Sales, green = Engineering" without needing to read labels.
 */

// One hue per workspace, with every class a surface needs spelled out in full
// (Tailwind only ships classes it can read): the tint (`bg`/`text`/`border`), a
// gradient for accent bars and the monogram, the solid accent and label colour, an icon chip, a
// hover ring and shadow for cards, and a soft glow behind a hero.
const WORKSPACE_COLORS = [
  {
    bg: 'bg-blue-500/15', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-500/30',
    gradient: 'from-blue-500 to-indigo-500', accent: 'bg-blue-500', label: 'text-blue-500',
    icon: 'text-blue-500 bg-blue-500/10 border-blue-500/20', ring: 'hover:border-blue-500/40', shadow: 'hover:shadow-blue-500/10',
    glow: 'bg-blue-500/20',
  },
  {
    bg: 'bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400', border: 'border-emerald-500/30',
    gradient: 'from-emerald-500 to-teal-500', accent: 'bg-emerald-500', label: 'text-emerald-500',
    icon: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20', ring: 'hover:border-emerald-500/40', shadow: 'hover:shadow-emerald-500/10',
    glow: 'bg-emerald-500/20',
  },
  {
    bg: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400', border: 'border-amber-500/30',
    gradient: 'from-amber-500 to-orange-500', accent: 'bg-amber-500', label: 'text-amber-500',
    icon: 'text-amber-500 bg-amber-500/10 border-amber-500/20', ring: 'hover:border-amber-500/40', shadow: 'hover:shadow-amber-500/10',
    glow: 'bg-amber-500/20',
  },
  {
    bg: 'bg-violet-500/15', text: 'text-violet-600 dark:text-violet-400', border: 'border-violet-500/30',
    gradient: 'from-violet-500 to-fuchsia-500', accent: 'bg-violet-500', label: 'text-violet-500',
    icon: 'text-violet-500 bg-violet-500/10 border-violet-500/20', ring: 'hover:border-violet-500/40', shadow: 'hover:shadow-violet-500/10',
    glow: 'bg-violet-500/20',
  },
  {
    bg: 'bg-rose-500/15', text: 'text-rose-600 dark:text-rose-400', border: 'border-rose-500/30',
    gradient: 'from-rose-500 to-pink-500', accent: 'bg-rose-500', label: 'text-rose-500',
    icon: 'text-rose-500 bg-rose-500/10 border-rose-500/20', ring: 'hover:border-rose-500/40', shadow: 'hover:shadow-rose-500/10',
    glow: 'bg-rose-500/20',
  },
  {
    bg: 'bg-teal-500/15', text: 'text-teal-600 dark:text-teal-400', border: 'border-teal-500/30',
    gradient: 'from-teal-500 to-cyan-500', accent: 'bg-teal-500', label: 'text-teal-500',
    icon: 'text-teal-500 bg-teal-500/10 border-teal-500/20', ring: 'hover:border-teal-500/40', shadow: 'hover:shadow-teal-500/10',
    glow: 'bg-teal-500/20',
  },
  {
    bg: 'bg-orange-500/15', text: 'text-orange-600 dark:text-orange-400', border: 'border-orange-500/30',
    gradient: 'from-orange-500 to-amber-500', accent: 'bg-orange-500', label: 'text-orange-500',
    icon: 'text-orange-500 bg-orange-500/10 border-orange-500/20', ring: 'hover:border-orange-500/40', shadow: 'hover:shadow-orange-500/10',
    glow: 'bg-orange-500/20',
  },
  {
    bg: 'bg-cyan-500/15', text: 'text-cyan-600 dark:text-cyan-400', border: 'border-cyan-500/30',
    gradient: 'from-cyan-500 to-blue-500', accent: 'bg-cyan-500', label: 'text-cyan-500',
    icon: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/20', ring: 'hover:border-cyan-500/40', shadow: 'hover:shadow-cyan-500/10',
    glow: 'bg-cyan-500/20',
  },
  {
    bg: 'bg-pink-500/15', text: 'text-pink-600 dark:text-pink-400', border: 'border-pink-500/30',
    gradient: 'from-pink-500 to-rose-500', accent: 'bg-pink-500', label: 'text-pink-500',
    icon: 'text-pink-500 bg-pink-500/10 border-pink-500/20', ring: 'hover:border-pink-500/40', shadow: 'hover:shadow-pink-500/10',
    glow: 'bg-pink-500/20',
  },
  {
    bg: 'bg-indigo-500/15', text: 'text-indigo-600 dark:text-indigo-400', border: 'border-indigo-500/30',
    gradient: 'from-indigo-500 to-violet-500', accent: 'bg-indigo-500', label: 'text-indigo-500',
    icon: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/20', ring: 'hover:border-indigo-500/40', shadow: 'hover:shadow-indigo-500/10',
    glow: 'bg-indigo-500/20',
  },
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
 * The Playground is always violet, so it reads as the sandbox wherever it appears.
 */
export function workspaceColor(workspaceId: string, kind?: string): WorkspaceColorSet {
  if (kind === 'playground') return WORKSPACE_COLORS[3]
  const index = simpleHash(workspaceId) % WORKSPACE_COLORS.length
  return WORKSPACE_COLORS[index]
}

/** A workspace's initials for its monogram: two letters of a one-word name,
 *  else the first letter of its first two words. */
export function workspaceMonogram(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}
