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
import { byFolder, fieldChangeCounts, fieldsOfChange, keyDifferences, type FieldChange } from '../model/fieldDiff'
import { ReviewValue } from './ReviewValue'
import { fieldTone } from '../model/changeTone'
import { FieldCountChips } from './ChangeSummary'
import { Disclosure } from '@/components/ui/Disclosure'

/** Rows shown before "Show all": enough to read an edit, few enough to draw at once. */
export const FIRST_ROWS = 25

const COUNT_STYLE: Record<FieldChange['kind'], string> = {
  changed: fieldTone('changed').text,
  added: fieldTone('added').text,
  removed: fieldTone('removed').text,
}

/** At most this many key differences (`depth="key"`). */
export const KEY_ROWS = 5

export function EntityDiff({ change, fields, fieldAction, depth = 'all', totalFields, onShowAll }: {
  change: GraphChange
  /** Rows already worked out (a revision's, from the history endpoint). */
  fields?: FieldChange[]
  /** Something to do with each field (a review: comment on it). */
  fieldAction?: (field: FieldChange) => ReactNode
  /** `key`: the few that say what the change is about; `all`: every field, by section. */
  depth?: 'key' | 'all'
  /** How many fields changed in all, when `fields` holds only some (a summary's top few). */
  totalFields?: number
  /** "Show all N fields": the caller opens the change the rest of the way. */
  onShowAll?: () => void
}) {
  const technical = usePersonaMode() === 'technical'
  const [all, setAll] = useState(false)
  const [raw, setRaw] = useState(false)
  const rows = useMemo(() => fields ?? fieldsOfChange(change), [fields, change])
  const counts = useMemo(() => fieldChangeCounts(rows), [rows])
  const [showAll, setShowAll] = useState(false)
  const keyOnly = depth === 'key' && !showAll
  const sections = useMemo(() => (keyOnly ? [] : byFolder(rows)), [rows, keyOnly])
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

  if (keyOnly) {
    const key = keyDifferences(rows, KEY_ROWS)
    const total = Math.max(totalFields ?? rows.length, rows.length)
    return (
      <div className="space-y-1.5">
        <div className="rounded-xl border border-glass-border overflow-hidden bg-black/[0.015] dark:bg-white/[0.02]">
          {key.map((f, i) => <ReviewValue key={`${f.folder ?? ''}/${f.label}/${i}`} field={f} plain={whole} action={fieldAction?.(f)} />)}
        </div>
        {total > key.length && (
          <button type="button" onClick={() => (onShowAll ? onShowAll() : setShowAll(true))}
            className="text-[11px] font-semibold text-accent-lineage hover:underline px-0.5">
            Show all {total.toLocaleString()} fields
          </button>
        )}
      </div>
    )
  }

  const folders = sections.filter((sec) => sec.folder !== null)
  if (folders.length > 0) {
    // Every field, in sections: the entity's own and loose properties, then each folder — opened at
    // once when there are few, a heading with its counts when there are many.
    const loose = sections.find((sec) => sec.folder === null)
    return (
      <div className="space-y-2">
        <CountLine whole={whole} status={change.status} rows={rows} counts={counts} />
        {loose && <SectionRows fields={loose.fields} plain={whole} fieldAction={fieldAction} />}
        {folders.map((sec) => (
          <Disclosure key={sec.folder} defaultOpen={sections.length <= 3}
            buttonClassName="py-1 px-0.5"
            summary={(
              <span className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-[11px] font-semibold text-ink-secondary truncate">{sec.folder!.split('/').join(' › ')}</span>
                <span className="text-[10.5px] text-ink-muted tabular-nums">{sec.fields.length.toLocaleString()}</span>
                {!whole && <FieldCountChips summary={sec.counts} />}
              </span>
            )}>
            <div className="mt-1"><SectionRows fields={sec.fields} plain={whole} fieldAction={fieldAction} /></div>
          </Disclosure>
        ))}
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

function CountLine({ whole, status, rows, counts }: {
  whole: boolean
  status: GraphChange['status']
  rows: FieldChange[]
  counts: Record<FieldChange['kind'], number>
}) {
  return (
    <p className="flex items-center gap-1.5 flex-wrap text-[11px] text-ink-muted px-0.5">
      {whole ? (
        <span>{rows.length} field{rows.length === 1 ? '' : 's'} {status === 'added' ? 'set' : 'removed'}</span>
      ) : (
        (['changed', 'added', 'removed'] as const).filter((k) => counts[k] > 0).map((k, i) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>·</span>}
            <span className={cn('font-semibold tabular-nums', COUNT_STYLE[k])}>{counts[k].toLocaleString()} {k}</span>
          </span>
        ))
      )}
    </p>
  )
}

/** One section's rows, the first `FIRST_ROWS` and then the rest on request. */
function SectionRows({ fields, plain, fieldAction }: {
  fields: FieldChange[]
  plain: boolean
  fieldAction?: (field: FieldChange) => ReactNode
}) {
  const [all, setAll] = useState(false)
  const shown = all ? fields : fields.slice(0, FIRST_ROWS)
  return (
    <div className="space-y-1">
      <div className="rounded-xl border border-glass-border overflow-hidden bg-black/[0.015] dark:bg-white/[0.02]">
        {shown.map((f, i) => <ReviewValue key={`${f.folder ?? ''}/${f.label}/${i}`} field={f} plain={plain} action={fieldAction?.(f)} />)}
      </div>
      {fields.length > FIRST_ROWS && (
        <button type="button" onClick={() => setAll((v) => !v)} className="text-[11px] font-semibold text-accent-lineage hover:underline px-0.5">
          {all ? 'Show fewer' : `Show all ${fields.length.toLocaleString()}`}
        </button>
      )}
    </div>
  )
}
