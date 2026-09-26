/**
 * The lineage DIRECTION colours — one pair for the whole product.
 *
 * Incoming (upstream) and outgoing (downstream) lineage wore a different pair
 * on every surface: sky/amber on the Focus Lens, cyan/amber on a trace,
 * blue/green in the entity drawer, and the canvas's own ports in yet another.
 * A reader who learnt one surface was misled by the next. Now every surface
 * reads this pair — the canvas's lineage ports, the drawer's lineage section,
 * the Focus Lens's wires and handles, a trace's lines — and the reader can
 * choose it (Display > Lineage > Appearance). The default is blue in, green
 * out — the entity drawer's original pair, which readers took to most.
 *
 * CSS reads the pair from custom properties on the root
 * (`--nx-lineage-in-rgb` / `--nx-lineage-out-rgb`, and Tailwind's
 * `lineage-in` / `lineage-out`); code that needs a real colour value — SVG
 * attributes cannot resolve `var()` — reads it through
 * `useLineageDirectionColors`.
 */
export interface LineageDirectionColors {
  /** Incoming — upstream. */
  in: string
  /** Outgoing — downstream. */
  out: string
}

export const DEFAULT_LINEAGE_DIRECTION_COLORS: LineageDirectionColors = { in: '#3b82f6', out: '#22c55e' }

/** Pairs chosen to stay apart for common colour-vision deficiencies and to
 *  read on both themes. The first is the default. */
export const LINEAGE_DIRECTION_PRESETS: ReadonlyArray<{ id: string; label: string } & LineageDirectionColors> = [
  { id: 'blue-green', label: 'Blue & green', in: '#3b82f6', out: '#22c55e' },
  { id: 'sky-amber', label: 'Sky & amber', in: '#0ea5e9', out: '#f59e0b' },
  { id: 'blue-orange', label: 'Blue & orange', in: '#3b82f6', out: '#f97316' },
  { id: 'teal-rose', label: 'Teal & rose', in: '#14b8a6', out: '#f43f5e' },
]

const HEX = /^#([0-9a-f]{6})$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

/** A stored pair, with anything malformed falling back to the default. */
export function resolveLineageDirectionColors(stored: Partial<LineageDirectionColors> | null | undefined): LineageDirectionColors {
  return {
    in: isHexColor(stored?.in) ? stored!.in! : DEFAULT_LINEAGE_DIRECTION_COLORS.in,
    out: isHexColor(stored?.out) ? stored!.out! : DEFAULT_LINEAGE_DIRECTION_COLORS.out,
  }
}

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `#0ea5e9` → `14 165 233`, the form `rgb(var(--x) / a)` needs. */
export function hexToChannels(hex: string): string {
  return channels(hex).join(' ')
}

/**
 * The colour `filter: saturate(amount)` would paint — the CSS/SVG spec's
 * luminance-preserving saturate matrix, not an HSL desaturation (the two
 * differ visibly). The Focus Lens bakes its off-cone wire colour with it
 * rather than paying for a `filter` per wire.
 */
export function saturateHex(hex: string, amount: number): string {
  const [r, g, b] = channels(hex)
  const s = amount
  const m = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ]
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  const out = [
    clamp(m[0] * r + m[1] * g + m[2] * b),
    clamp(m[3] * r + m[4] * g + m[5] * b),
    clamp(m[6] * r + m[7] * g + m[8] * b),
  ]
  return `#${out.map(v => v.toString(16).padStart(2, '0')).join('')}`
}
