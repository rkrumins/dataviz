/**
 * What changed on one entity, property by property: each field and each property its own row,
 * named the way the drawer names them and shown as the value it is (`ReviewValue`) — never one
 * `properties: {…} → {…}` line. A summary first ("2 changed · 1 added"), the first rows, then all of
 * them on request; the technical persona can open the raw before and after.
 *
 * Built only for the row someone opens — never up front for every change of a list.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Code2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePersonaMode } from '@/store/persona'
import { JsonTree } from '@/components/ui/JsonTree'
import type { GraphChange } from '../model/changeModel'
import { entityFieldChanges, fieldChangeCounts, fromFieldDeltas, type FieldChange } from '../model/fieldDiff'
import { ReviewValue } from './ReviewValue'

/** Rows shown before "Show all": enough to read an edit, few enough to draw at once. */
export const FIRST_ROWS = 25

const COUNT_STYLE: Record<FieldChange['kind'], string> = {
  changed: 'text-amber-700 dark:text-amber-300',
  added: 'text-emerald-700 dark:text-emerald-300',
  removed: 'text-rose-700 dark:text-rose-300',
}

/** The rows for a change: from its two sides where it has them, else from its field deltas. */
function rowsOf(change: GraphChange): FieldChange[] {
  if (change.status === 'modified' && !(change.before && change.after) && change.fields) {
    return fromFieldDeltas(change.fields, change.kind)
  }
  return entityFieldChanges(change.status === 'added' ? undefined : change.before,
    change.status === 'removed' ? undefined : change.after, change.kind)
}

export function EntityDiff({ change, fields, fieldAction }: {
  change: GraphChange
  /** Rows already worked out (a revision's, from the history endpoint). */
  fields?: FieldChange[]
  /** Something to do with each field (a review: comment on it). */
  fieldAction?: (field: FieldChange) => ReactNode
}) {
  const technical = usePersonaMode() === 'technical'
  const [all, setAll] = useState(false)
  const [raw, setRaw] = useState(false)
  const rows = useMemo(() => fields ?? rowsOf(change), [fields, change])
  const counts = useMemo(() => fieldChangeCounts(rows), [rows])
  const whole = change.status !== 'modified'
  const hasRaw = !!(change.before || change.after)

  const rawToggle = technical && hasRaw && (
    <div>
      <button type="button" onClick={() => setRaw((v) => !v)}
        className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-muted hover:text-ink">
        <Code2 className="w-3 h-3" aria-hidden />{raw ? 'Hide technical details' : 'Technical details'}
      </button>
      {raw && (
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          {(['before', 'after'] as const).filter((side) => change[side]).map((side) => (
            <div key={side} className="min-w-0">
              <p className="mb-1 text-[10.5px] font-semibold text-ink-muted">{side === 'before' ? 'Before' : 'After'}</p>
              <JsonTree value={change[side]} label={side === 'before' ? 'Before' : 'After'} openDepth={2} />
            </div>
          ))}
        </div>
      )}
    </div>
  )

  if (rows.length === 0) {
    return (
      <div className="space-y-1">
        <p className="text-[11px] text-ink-muted px-2 py-1.5">No field-level detail.</p>
        {rawToggle}
      </div>
    )
  }

  const shown = all ? rows : rows.slice(0, FIRST_ROWS)
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 flex-wrap text-[11px] text-ink-muted px-0.5">
        {whole ? (
          <span>{rows.length} field{rows.length === 1 ? '' : 's'} {change.status === 'added' ? 'set' : 'removed'}</span>
        ) : (
          (['changed', 'added', 'removed'] as const).filter((k) => counts[k] > 0).map((k, i) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              {i > 0 && <span aria-hidden>·</span>}
              <span className={cn('font-semibold tabular-nums', COUNT_STYLE[k])}>{counts[k].toLocaleString()} {k}</span>
            </span>
          ))
        )}
      </p>
      <div className="rounded-xl border border-glass-border overflow-hidden bg-black/[0.015] dark:bg-white/[0.02]">
        {shown.map((f, i) => <ReviewValue key={`${f.folder ?? ''}/${f.label}/${i}`} field={f} plain={whole} action={fieldAction?.(f)} />)}
      </div>
      {rows.length > FIRST_ROWS && (
        <button type="button" onClick={() => setAll((v) => !v)}
          className="text-[11px] font-semibold text-accent-lineage hover:underline px-0.5">
          {all ? 'Show fewer' : `Show all ${rows.length.toLocaleString()}`}
        </button>
      )}
      {rawToggle}
    </div>
  )
}
