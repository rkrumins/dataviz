/**
 * useTypewriter — cycles through a list of strings with a typing /
 * pausing / deleting animation. Produces the "live placeholder" effect
 * you see on modern marketing search bars where the prompt feels like
 * someone is typing suggestions at you.
 *
 * The hook returns the current displayed slice of a phrase plus a
 * "caret" flag the consumer can use to render a blinking cursor.
 * Designed to be paused externally via the ``enabled`` prop so it
 * doesn't compete with real user input.
 */
import { useEffect, useRef, useState } from 'react'

interface UseTypewriterOptions {
  /** Phrases to cycle through, in order. */
  phrases: string[]
  /** Whether the typewriter should run. Pause when the input is focused / filled. */
  enabled?: boolean
  /** Milliseconds between keystrokes when typing. */
  typeSpeedMs?: number
  /** Milliseconds between keystrokes when deleting. */
  deleteSpeedMs?: number
  /** Milliseconds to hold a fully-typed phrase before deleting. */
  holdMs?: number
  /** Milliseconds to wait at empty before typing the next phrase. */
  gapMs?: number
}

export function useTypewriter({
  phrases,
  enabled = true,
  typeSpeedMs = 55,
  deleteSpeedMs = 28,
  holdMs = 1_800,
  gapMs = 350,
}: UseTypewriterOptions): string {
  const [text, setText] = useState('')
  const phraseIndex = useRef(0)
  const charIndex = useRef(0)
  const phase = useRef<'typing' | 'holding' | 'deleting' | 'gap'>('typing')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled || phrases.length === 0) {
      if (timer.current) clearTimeout(timer.current)
      setText('')
      phraseIndex.current = 0
      charIndex.current = 0
      phase.current = 'typing'
      return
    }

    const tick = () => {
      const current = phrases[phraseIndex.current] ?? ''

      switch (phase.current) {
        case 'typing': {
          if (charIndex.current < current.length) {
            charIndex.current += 1
            setText(current.slice(0, charIndex.current))
            timer.current = setTimeout(tick, typeSpeedMs)
          } else {
            phase.current = 'holding'
            timer.current = setTimeout(tick, holdMs)
          }
          break
        }
        case 'holding': {
          phase.current = 'deleting'
          timer.current = setTimeout(tick, deleteSpeedMs)
          break
        }
        case 'deleting': {
          if (charIndex.current > 0) {
            charIndex.current -= 1
            setText(current.slice(0, charIndex.current))
            timer.current = setTimeout(tick, deleteSpeedMs)
          } else {
            phase.current = 'gap'
            timer.current = setTimeout(tick, gapMs)
          }
          break
        }
        case 'gap': {
          phraseIndex.current = (phraseIndex.current + 1) % phrases.length
          phase.current = 'typing'
          timer.current = setTimeout(tick, typeSpeedMs)
          break
        }
      }
    }

    timer.current = setTimeout(tick, typeSpeedMs)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, phrases.join('\u0001')])

  return text
}
