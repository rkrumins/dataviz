/**
 * useTypewriter — cycles through a list of strings with a typing /
 * pausing / deleting animation that feels humanly-paced rather than
 * mechanical.
 *
 * ─── PERFORMANCE CONTRACT: this hook holds NO React state ────────────────────
 * It writes the animated text (and toggles the caret's blink class) STRAIGHT to
 * the DOM through refs, so it triggers ZERO re-renders.
 *
 * This is deliberate, and load-bearing. The animation ticks every 22–70ms,
 * forever, for as long as the field sits empty and unfocused. Driving it through
 * `useState` re-rendered the whole consuming page on every keystroke — ~20–45
 * full re-renders per second, each one re-rendering every result card. React 19's
 * DEV build emits a `performance.measure()` on every render and NEVER clears it
 * (mark/measure entries have no buffer cap, unlike resource entries), so an
 * "idle" page quietly accumulated millions of retained PerformanceMeasure objects
 * — a heap that climbed to multiple GB. It also burned CPU continuously in
 * production, where a page nobody is touching should cost nothing.
 *
 * A purely visual, high-frequency effect with no other consumer belongs in the
 * DOM, not in the render tree. Keep it that way: do not reintroduce state here.
 *
 * Techniques borrowed from modern marketing typewriter UIs:
 *   • Jittered per-character delays (humans don't type on a metronome)
 *   • Brief extra pauses after spaces and punctuation
 *   • Deletion slightly faster than typing (natural when correcting)
 *   • The caret blinks only while the text sits still — mimics a real terminal
 *     cursor. The hook toggles `typewriter-caret-blink` on `caretRef` itself.
 *
 * The hook pauses itself (and clears the text) when `enabled` flips to false, so
 * the live placeholder disappears the instant the user focuses the input.
 */
import { useEffect, useRef, type RefObject } from 'react'

export type TypewriterPhase = 'typing' | 'holding' | 'deleting' | 'gap'

export interface UseTypewriterResult {
  /** Attach to the element that shows the animated text (hook writes textContent). */
  textRef: RefObject<HTMLSpanElement | null>
  /** Attach to the caret element (hook toggles its blink class). */
  caretRef: RefObject<HTMLSpanElement | null>
}

interface UseTypewriterOptions {
  /** Phrases to cycle through, in order. */
  phrases: string[]
  /** Whether the typewriter should run. Pause when the input is focused / filled. */
  enabled?: boolean
  /** Base milliseconds per keystroke when typing (±jitter). */
  typeSpeedMs?: number
  /** Base milliseconds per keystroke when deleting. */
  deleteSpeedMs?: number
  /** ±jitter applied to each keystroke so pacing feels organic. */
  jitterMs?: number
  /** Milliseconds to hold a fully-typed phrase before starting to delete. */
  holdMs?: number
  /** Milliseconds to wait between phrases. */
  gapMs?: number
  /** Extra milliseconds to linger after typing a space or punctuation. */
  punctuationPauseMs?: number
}

const PUNCTUATION = new Set([' ', ',', '.', ';', ':', '—', '…', '?', '!'])
const CARET_BLINK_CLASS = 'typewriter-caret-blink'

function jittered(base: number, jitter: number): number {
  if (jitter <= 0) return base
  return Math.max(10, Math.round(base + (Math.random() - 0.5) * 2 * jitter))
}

export function useTypewriter({
  phrases,
  enabled = true,
  typeSpeedMs = 48,
  deleteSpeedMs = 22,
  jitterMs = 22,
  holdMs = 2400,
  gapMs = 520,
  punctuationPauseMs = 90,
}: UseTypewriterOptions): UseTypewriterResult {
  const textRef = useRef<HTMLSpanElement | null>(null)
  const caretRef = useRef<HTMLSpanElement | null>(null)

  const phraseIndex = useRef(0)
  const charIndex = useRef(0)
  const phaseRef = useRef<TypewriterPhase>('typing')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Both writers target the DOM directly — never setState (see the contract above).
    const writeText = (slice: string) => {
      if (textRef.current) textRef.current.textContent = slice
    }
    const enterPhase = (next: TypewriterPhase) => {
      phaseRef.current = next
      const moving = next === 'typing' || next === 'deleting'
      // Caret is solid while keys are flying; blinks only when the text is still.
      caretRef.current?.classList.toggle(CARET_BLINK_CLASS, !moving)
    }

    if (!enabled || phrases.length === 0) {
      if (timer.current) clearTimeout(timer.current)
      phraseIndex.current = 0
      charIndex.current = 0
      writeText('')
      enterPhase('typing')
      return
    }

    enterPhase('typing')

    const tick = () => {
      const current = phrases[phraseIndex.current] ?? ''

      switch (phaseRef.current) {
        case 'typing': {
          if (charIndex.current < current.length) {
            charIndex.current += 1
            const nextSlice = current.slice(0, charIndex.current)
            writeText(nextSlice)
            const lastChar = nextSlice[nextSlice.length - 1]
            const extra = lastChar && PUNCTUATION.has(lastChar) ? punctuationPauseMs : 0
            timer.current = setTimeout(tick, jittered(typeSpeedMs, jitterMs) + extra)
          } else {
            enterPhase('holding')
            timer.current = setTimeout(tick, holdMs)
          }
          break
        }
        case 'holding': {
          enterPhase('deleting')
          timer.current = setTimeout(tick, deleteSpeedMs)
          break
        }
        case 'deleting': {
          if (charIndex.current > 0) {
            charIndex.current -= 1
            writeText(current.slice(0, charIndex.current))
            timer.current = setTimeout(tick, jittered(deleteSpeedMs, jitterMs / 2))
          } else {
            enterPhase('gap')
            timer.current = setTimeout(tick, gapMs)
          }
          break
        }
        case 'gap': {
          phraseIndex.current = (phraseIndex.current + 1) % phrases.length
          enterPhase('typing')
          timer.current = setTimeout(tick, jittered(typeSpeedMs, jitterMs))
          break
        }
      }
    }

    timer.current = setTimeout(tick, jittered(typeSpeedMs, jitterMs))
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // The refs are read at tick time, not deps; re-keying the effect only when
    // enabled/phrases change keeps the schedule stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, phrases.join('\u0001')])

  return { textRef, caretRef }
}
