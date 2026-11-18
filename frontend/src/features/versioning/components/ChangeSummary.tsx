/**
 * ChangeSummary — what a change did, in one line, before anyone opens it:
 * "Edited **Owner**, **Tier** and 2 more", "Edited Owner · added Steward", "New · 12 fields",
 * "Removed" — with its counts in the change colours (`~3 +1 −1`, the tree's orange, green, rose).
 * Where no field changed (a move, a re-link), the caller's sentence says what did.
 */
import { memo, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { ChangeStatus } from '../model/changeModel'
import { fieldTone } from '../model/changeTone'
import type { FieldSummary } from '../model/fieldDiff'

const VERB: Record<'changed' | 'added' | 'removed', string> = { changed: 'Edited', added: 'Added', removed: 'Removed' }

/** "Edited Owner, Tier and 2 more" — the words, without the counts. */
export function summaryWords(summary: FieldSummary, status: ChangeStatus, kind: 'node' | 'edge' = 'node'): string {
  if (status === 'added') return `New${kind === 'edge' ? ' link' : ''}${summary.total ? ` · ${summary.total} field${summary.total === 1 ? '' : 's'}` : ''}`
  if (status === 'removed') return kind === 'edge' ? 'Link removed' : 'Removed'
  if (summary.total === 0) return 'No field changes'
  const shown = summary.top
  const rest = summary.total - shown.length
  if (rest <= 0) {
    // Few enough to name each with its own verb: "Edited Owner · added Steward".
    const parts: string[] = []
    for (const kind of ['changed', 'added', 'removed'] as const) {
      const names = shown.filter((f) => f.kind === kind).map((f) => f.label)
      if (names.length) parts.push(`${parts.length ? VERB[kind].toLowerCase() : VERB[kind]} ${joinNames(names)}`)
    }
    return parts.join(' · ')
  }
  const verb = summary.changed > 0 ? 'Edited' : summary.added > 0 ? 'Added' : 'Removed'
  return `${verb} ${shown.map((f) => f.label).join(', ')} and ${rest.toLocaleString()} more`
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The counts as the change colours: `~3 +1 −1`, read out in words. */
export function FieldCountChips({ summary, className }: { summary: Pick<FieldSummary, 'changed' | 'added' | 'removed'>; className?: string }) {
  const parts = [
    { n: summary.changed, sign: '~', kind: 'changed' as const, word: 'edited' },
    { n: summary.added, sign: '+', kind: 'added' as const, word: 'added' },
    { n: summary.removed, sign: '−', kind: 'removed' as const, word: 'removed' },
  ].filter((p) => p.n > 0)
  if (!parts.length) return null
  return (
    <span className={cn('inline-flex items-center gap-1 tabular-nums', className)}>
      <span className="sr-only">{parts.map((p) => `${p.n} ${p.word}`).join(', ')}</span>
      {parts.map((p) => (
        <span key={p.kind} aria-hidden className={cn('px-1 rounded text-[10px] font-bold leading-4', fieldTone(p.kind).chip)}>
          {p.sign}{p.n.toLocaleString()}
        </span>
      ))}
    </span>
  )
}

export const ChangeSummary = memo(function ChangeSummary({ summary, status, kind = 'node', fallback, className }: {
  summary: FieldSummary | null | undefined
  status: ChangeStatus
  kind?: 'node' | 'edge'
  /** What to say when the fields don't tell it (a move, a re-link) or aren't known. */
  fallback?: ReactNode
  className?: string
}) {
  const words = summary ? summaryWords(summary, status, kind) : null
  const say = !summary || (status === 'modified' && summary.total === 0) ? fallback : words
  if (!say) return null
  return (
    <span className={cn('flex items-center gap-1.5 min-w-0 text-[11.5px] text-ink-secondary', className)}>
      <span className="truncate">{say}</span>
      {summary && status === 'modified' && <FieldCountChips summary={summary} className="shrink-0" />}
    </span>
  )
})
