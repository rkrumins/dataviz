/**
 * The platform's keyboard conventions: which modifier is "primary" (⌘ on Apple, Ctrl elsewhere)
 * and how a shortcut is written for it. One place, so a shortcut hint and the handler that
 * honours it can never disagree.
 */

/** Apple keyboards — ⌘ is the primary modifier. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** The event carries the platform's primary modifier (and not the other one). */
export function hasPrimaryModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isApplePlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

const MAC_GLYPH: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', enter: '↵', esc: 'Esc' }
const PC_NAME: Record<string, string> = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl', enter: 'Enter', esc: 'Esc' }

/** `"mod+s"` → `"⌘S"` on Apple, `"Ctrl+S"` elsewhere. Keys are joined with `+`. */
export function formatShortcut(shortcut: string, apple: boolean = isApplePlatform()): string {
  const parts = shortcut.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean)
  const names = parts.map((p) => (apple ? MAC_GLYPH[p] : PC_NAME[p]) ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
  return apple ? names.join('') : names.join('+')
}
