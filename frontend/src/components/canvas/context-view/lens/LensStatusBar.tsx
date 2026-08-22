/**
 * LensStatusBar — the Lens's footer as a status bar (2026-08-22).
 *
 * It was one italic sentence of hints — "Click a card to inspect · ⊕ to
 * walk a hop · …" — and fifteen hundred pixels of nothing. A footer on a
 * full-screen room is where an editor keeps its status bar, and that is
 * what this is:
 *
 *  • LEFT — the gestures, as keycaps: the thing to press, then what it
 *    does. Scannable in a glance, where a sentence had to be read.
 *  • MIDDLE — what the wires MEAN: upstream and downstream in the colours
 *    the wires land in, the dashed "≈ coarse" seam, the heavy bundle. The
 *    board draws four kinds of line; a business reader should not have to
 *    infer them.
 *  • RIGHT — live facts about the board: cards, wires, bundles, zoom.
 *
 * Presentational; everything it says is handed in. The zoom is null until
 * the board has settled a viewport.
 */
import { cn } from '@/lib/utils'

/** The wire tints, as FocusGraphView lands them. */
const TINT_UP = '#0ea5e9'
const TINT_DOWN = '#f59e0b'

/** The gestures, most essential first. A narrow bar DROPS the last ones
 *  rather than clipping one mid-word ("Esc ·" was the 1,280px reading);
 *  the four that are always there are the ones a first-time reader needs. */
const KEYS: ReadonlyArray<{ key: string; does: string; from?: string }> = [
  { key: 'Click', does: 'inspect' },
  { key: '⊕', does: 'walk a hop' },
  { key: '▸', does: 'open what is inside' },
  { key: '↑↓', does: 'browse rows', from: 'hidden 2xl:flex' },
  { key: '↵', does: 'preview', from: 'hidden xl:flex' },
  { key: '⇧↵', does: 'focus there', from: 'hidden 2xl:flex' },
  { key: 'Esc', does: 'close' },
]

function Keycap({ children }: { children: string }) {
  return (
    <kbd
      className="inline-flex items-center justify-center min-w-[1.35rem] h-[1.15rem] px-1 rounded-[5px] border border-black/[0.12] dark:border-white/[0.14] border-b-[2px] bg-canvas-elevated text-[9.5px] font-semibold text-ink/80 font-sans not-italic leading-none"
    >
      {children}
    </kbd>
  )
}

function Swatch({ kind }: { kind: 'up' | 'down' | 'coarse' | 'bundle' }) {
  const stroke = kind === 'up' ? TINT_UP : TINT_DOWN
  return (
    <svg aria-hidden="true" viewBox="0 0 28 8" className="w-7 h-2 flex-shrink-0">
      <line
        x1="1" y1="4" x2="27" y2="4"
        stroke={stroke}
        strokeWidth={kind === 'bundle' ? 4.5 : 1.8}
        strokeLinecap="round"
        strokeDasharray={kind === 'coarse' ? '5 3' : undefined}
        opacity={kind === 'bundle' ? 0.85 : 1}
      />
    </svg>
  )
}

/**
 * THE MARKS a card can carry (2026-08-23) — the two most-asked-about
 * glyphs on the board. ⊕ is also a gesture (the keycaps say "walk a
 * hop"); this says what its PRESENCE means: the data source has more
 * this way. ⊘ is the other half, and the one nobody guesses: the walk
 * asked and there is nothing further — an answer, not a failure.
 */
const MARKS: ReadonlyArray<{ glyph: string; label: string; tint: string }> = [
  { glyph: '⊕', label: 'more to fetch', tint: 'text-accent-lineage' },
  { glyph: '⊘', label: 'nothing further', tint: 'text-ink-muted/70' },
]

const LEGEND: ReadonlyArray<{ kind: 'up' | 'down' | 'coarse' | 'bundle'; label: string }> = [
  { kind: 'up', label: 'upstream' },
  { kind: 'down', label: 'downstream' },
  { kind: 'coarse', label: '≈ coarse' },
  { kind: 'bundle', label: 'bundle' },
]

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

export interface LensStatusBarProps {
  cards: number
  wires: number
  bundles: number
  /** The board's zoom once a viewport has settled; null before. */
  zoom: number | null
  className?: string
}

export function LensStatusBar({ cards, wires, bundles, zoom, className }: LensStatusBarProps) {
  const facts = [
    plural(cards, 'card', 'cards'),
    plural(wires, 'wire', 'wires'),
    ...(bundles > 0 ? [plural(bundles, 'bundle', 'bundles')] : []),
    ...(zoom !== null ? [`${Math.round(zoom * 100)}%`] : []),
  ]
  return (
    <div className={cn('flex items-center gap-4 min-w-0 px-4 h-9 border-t border-black/[0.08] dark:border-white/[0.08] bg-black/[0.015] dark:bg-white/[0.02]', className)}>
      <dl className="flex items-center gap-x-3.5 min-w-0 whitespace-nowrap" aria-label="Gestures">
        {KEYS.map(({ key, does, from }) => (
          <div key={key} className={cn('items-center gap-1.5 flex-shrink-0', from ?? 'flex')}>
            <dt className="contents"><Keycap>{key}</Keycap></dt>
            <dd className="text-[10.5px] text-ink-muted">{does}</dd>
          </div>
        ))}
      </dl>
      <ul aria-label="What the marks mean" className="hidden lg:flex items-center gap-x-3 ml-auto flex-shrink-0 pl-4 border-l border-black/[0.08] dark:border-white/[0.08]">
        {MARKS.map(({ glyph, label, tint }) => (
          <li key={glyph} className="flex items-center gap-1.5 text-[10px] text-ink-muted whitespace-nowrap">
            <span aria-hidden="true" className={cn('text-[12px] leading-none', tint)}>{glyph}</span>
            {label}
          </li>
        ))}
      </ul>
      <ul aria-label="What the wires mean" className="hidden md:flex items-center gap-x-3 lg:ml-0 ml-auto flex-shrink-0 pl-4 border-l border-black/[0.08] dark:border-white/[0.08]">
        {LEGEND.map(({ kind, label }) => (
          <li key={kind} className="flex items-center gap-1.5 text-[10px] text-ink-muted whitespace-nowrap">
            <Swatch kind={kind} />
            {label}
          </li>
        ))}
      </ul>
      <p
        role="note"
        aria-label="On the board"
        className="flex-shrink-0 pl-4 border-l border-black/[0.08] dark:border-white/[0.08] text-[10.5px] tabular-nums text-ink-muted whitespace-nowrap"
      >
        {facts.join(' · ')}
      </p>
    </div>
  )
}
