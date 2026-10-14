/**
 * How Versioned and External look — the sync-status chip's icons and tones, so the
 * same fact reads the same wherever it appears.
 */
import { GitCommitHorizontal, Radar } from 'lucide-react'

export const SOURCE_KIND_META = {
  versioned: {
    icon: GitCommitHorizontal,
    active: 'text-violet-600 dark:text-violet-300 border-violet-500/30',
    glyph: 'text-violet-500',
  },
  external: {
    icon: Radar,
    active: 'text-sky-600 dark:text-sky-300 border-sky-500/30',
    glyph: 'text-sky-500',
  },
} as const
