/**
 * useReviewKeys — the review page's keys, anywhere on it but while typing (a field, a comment), in
 * a dialog or a menu, or where something nearer already answered (the change list's own keys):
 *   j / k  next / previous change · n / p  next / previous that still needs you (round to the start)
 *   ⇧N / ⇧P  next / previous with open threads · v  viewed, then the next · a / r  accept / reject
 *   c  comment on it · ⌘/Ctrl+↵  the review's next step · ?  these keys
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { hasPrimaryModifier } from '@/lib/platform'

export type ReviewKey =
  | 'next' | 'prev' | 'nextNeeding' | 'prevNeeding' | 'nextThread' | 'prevThread'
  | 'viewed' | 'accept' | 'reject' | 'comment' | 'primary' | 'help'

const PLAIN: Record<string, ReviewKey> = {
  j: 'next', k: 'prev', n: 'nextNeeding', p: 'prevNeeding', N: 'nextThread', P: 'prevThread',
  v: 'viewed', a: 'accept', r: 'reject', c: 'comment', '?': 'help',
}

/** What each key does, for `ShortcutsHint` — those that apply. */
export function reviewShortcuts({ canDecide }: { canDecide: boolean }): Array<readonly [string, string]> {
  return [
    ['j k', 'Next / previous change'],
    ['n p', 'Next / previous that still needs you'],
    ['shift+n shift+p', 'Next / previous with open threads'],
    ['v', 'Mark it viewed, then the next'],
    ...(canDecide ? [['a', 'Accept it'] as const, ['r', 'Reject it (asks why)'] as const] : []),
    ['c', 'Comment on it'],
    ['mod+enter', 'The review’s next step'],
    ['?', 'These shortcuts'],
  ]
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement
  || (t instanceof HTMLElement && (t.isContentEditable || !!t.closest('[role="dialog"], [role="menu"]')))

export function useReviewKeys(handlers: Partial<Record<ReviewKey, () => void>>) {
  const ref = useRef(handlers)
  useLayoutEffect(() => { ref.current = handlers })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target)) return
      const key = e.key === 'Enter' && hasPrimaryModifier(e) ? 'primary'
        : e.metaKey || e.ctrlKey || e.altKey ? undefined : PLAIN[e.key]
      const run = key && ref.current[key]
      if (!run) return
      e.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
