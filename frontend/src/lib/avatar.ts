/**
 * Shared avatar helpers.
 *
 * Derives initials and a deterministic colour palette from a user id so
 * every surface that renders a creator avatar (CreatorHoverCard, the
 * Creator filter dropdown, the view card footer) stays visually
 * consistent — the same person always gets the same swatch.
 */

export const AVATAR_PALETTE = [
  { bg: 'bg-indigo-500/10', text: 'text-indigo-600 dark:text-indigo-400', ring: 'ring-indigo-500/30' },
  { bg: 'bg-emerald-500/10', text: 'text-emerald-600 dark:text-emerald-400', ring: 'ring-emerald-500/30' },
  { bg: 'bg-violet-500/10', text: 'text-violet-600 dark:text-violet-400', ring: 'ring-violet-500/30' },
  { bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400', ring: 'ring-amber-500/30' },
  { bg: 'bg-sky-500/10', text: 'text-sky-600 dark:text-sky-400', ring: 'ring-sky-500/30' },
  { bg: 'bg-rose-500/10', text: 'text-rose-600 dark:text-rose-400', ring: 'ring-rose-500/30' },
  { bg: 'bg-cyan-500/10', text: 'text-cyan-600 dark:text-cyan-400', ring: 'ring-cyan-500/30' },
  { bg: 'bg-pink-500/10', text: 'text-pink-600 dark:text-pink-400', ring: 'ring-pink-500/30' },
] as const

export type AvatarPalette = typeof AVATAR_PALETTE[number]

/** Compute uppercase initials from a full name (max 2 characters). */
export function initialsOf(name: string | null | undefined): string {
  if (!name) return '?'
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(word => word[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

/**
 * Pick an avatar palette entry deterministically from a string seed.
 * Used for colouring creator avatars so the same user id always renders
 * with the same swatch across the UI.
 */
export function avatarPaletteFor(seed: string | null | undefined): AvatarPalette {
  if (!seed) return AVATAR_PALETTE[0]
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffff
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]
}
