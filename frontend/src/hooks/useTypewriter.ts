/**
 * useTypewriter — cycles through a list of strings with a typing /
 * pausing / deleting animation that feels humanly-paced rather than
 * mechanical.
 *
 * Techniques borrowed from modern marketing typewriter UIs:
 *   • Jittered per-character delays (humans don't type on a metronome)
 *   • Brief extra pauses after spaces and punctuation
 *   • Deletion slightly faster than typing (natural when correcting)
 *   • Exposes the current ``phase`` so callers can freeze the cursor
 *     blink while keys are flying and blink only when the text is
 *     sitting still — mimics the feel of a real terminal cursor.
 *
 * The hook pauses itself when ``enabled`` flips to false so the live
 * placeholder disappears the instant the user focuses the input.
 */
import { useEffect, useRef, useState } from 'react'

export type TypewriterPhase = 'typing' | 'holding' | 'deleting' | 'gap'

export interface UseTypewriterResult {
  /** Current visible slice of the active phrase. */
  text: string
  /** Which stage of the cycle we're in — useful for caret styling. */
  phase: TypewriterPhase
  /** True when the cursor is moving (typing or deleting). */
  isActive: boolean
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
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<TypewriterPhase>('typing')
  const phraseIndex = useRef(0)
  const charIndex = useRef(0)
  const phaseRef = useRef<TypewriterPhase>('typing')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep the ref in sync so the scheduler can read the latest phase
  // without triggering re-renders of the scheduling closure.
  phaseRef.current = phase

  useEffect(() => {
    if (!enabled || phrases.length === 0) {
      if (timer.current) clearTimeout(timer.current)
      setText('')
      setPhase('typing')
      phraseIndex.current = 0
      charIndex.current = 0
      return
    }

    const tick = () => {
      const current = phrases[phraseIndex.current] ?? ''

      switch (phaseRef.current) {
        case 'typing': {
          if (charIndex.current < current.length) {
            charIndex.current += 1
            const nextSlice = current.slice(0, charIndex.current)
            setText(nextSlice)
            const lastChar = nextSlice[nextSlice.length - 1]
            const extra = lastChar && PUNCTUATION.has(lastChar) ? punctuationPauseMs : 0
            timer.current = setTimeout(tick, jittered(typeSpeedMs, jitterMs) + extra)
          } else {
            setPhase('holding')
            timer.current = setTimeout(tick, holdMs)
          }
          break
        }
        case 'holding': {
          setPhase('deleting')
          timer.current = setTimeout(tick, deleteSpeedMs)
          break
        }
        case 'deleting': {
          if (charIndex.current > 0) {
            charIndex.current -= 1
            setText(current.slice(0, charIndex.current))
            timer.current = setTimeout(tick, jittered(deleteSpeedMs, jitterMs / 2))
          } else {
            setPhase('gap')
            timer.current = setTimeout(tick, gapMs)
          }
          break
        }
        case 'gap': {
          phraseIndex.current = (phraseIndex.current + 1) % phrases.length
          setPhase('typing')
          timer.current = setTimeout(tick, jittered(typeSpeedMs, jitterMs))
          break
        }
      }
    }

    timer.current = setTimeout(tick, jittered(typeSpeedMs, jitterMs))
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // phaseRef is read at tick time, not a dep; re-keying the effect
    // only when enabled or phrases change keeps the schedule stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, phrases.join('\u0001')])

  return {
    text,
    phase,
    isActive: phase === 'typing' || phase === 'deleting',
  }
}
