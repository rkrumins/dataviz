/**
 * ReviewValue — one changed field, before → after, shown as the value it is: tags as chips (what
 * was added, what was taken away), dates and links formatted, Yes/No as pills, long text clamped.
 * The plain-language counterpart of a JSON diff.
 */
import { memo, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { inferFieldType } from '@/components/panels/property/fieldTypes'
import { FormattedDate, FormattedLink } from '@/components/panels/property/valueWidgets'
import type { FieldChange } from '../model/fieldDiff'

const KIND_STYLE: Record<FieldChange['kind'], { badge: string; label: string }> = {
  added: { badge: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300', label: 'Added' },
  changed: { badge: 'bg-amber-500/12 text-amber-700 dark:text-amber-300', label: 'Changed' },
  removed: { badge: 'bg-rose-500/12 text-rose-700 dark:text-rose-300', label: 'Removed' },
}

function Empty() {
  return <span className="text-xs italic text-ink-muted">empty</span>
}

/** A value as it reads; `gone` strikes it through (what the save takes away). */
function Value({ value, gone = false }: { value: unknown; gone?: boolean }) {
  const [open, setOpen] = useState(false)
  if (value === undefined || value === null || value === '') return <Empty />
  const type = inferFieldType(value)
  const strike = gone && 'line-through decoration-rose-500/60 text-ink-muted'
  if (type === 'boolean') {
    return (
      <span className={cn('px-1.5 py-px rounded-md text-[11px] font-semibold',
        value ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' : 'bg-black/[0.05] dark:bg-white/10 text-ink-secondary', strike)}>
        {value ? 'Yes' : 'No'}
      </span>
    )
  }
  if (type === 'date') return <span className={cn(strike || undefined)}><FormattedDate value={String(value)} /></span>
  if (type === 'url') return gone ? <span className={cn('text-xs break-all', strike)}>{String(value)}</span> : <FormattedLink value={String(value)} />
  if (type === 'number') return <span className={cn('text-xs font-mono text-ink tabular-nums', strike)}>{String(value)}</span>
  if (type === 'tags' || type === 'list' || type === 'group') {
    const s = type === 'tags' ? (value as string[]).join(', ') : JSON.stringify(value)
    return <span className={cn('text-xs text-ink break-words font-mono', strike)}>{s.length > 160 ? `${s.slice(0, 157)}…` : s}</span>
  }
  const s = String(value)
  const long = s.length > 140 || s.includes('\n')
  return (
    <span className="min-w-0">
      <span className={cn('text-xs text-ink whitespace-pre-wrap break-words', long && !open && 'line-clamp-3', strike)}>{s}</span>
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="block text-2xs font-medium text-accent-lineage hover:underline mt-0.5">
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </span>
  )
}

/** Tags: what stays, what is added (+), what is taken away (−). */
function TagDiff({ before, after }: { before: string[]; after: string[] }) {
  const was = new Set(before)
  const now = new Set(after)
  const chips = [
    ...after.map((t) => ({ t, k: was.has(t) ? 'kept' : 'added' })),
    ...before.filter((t) => !now.has(t)).map((t) => ({ t, k: 'removed' })),
  ]
  if (chips.length === 0) return <Empty />
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map(({ t, k }) => (
        <span key={`${k}:${t}`} className={cn('px-1.5 py-px rounded-md text-[11px] font-medium',
          k === 'added' && 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
          k === 'removed' && 'bg-rose-500/12 text-rose-700 dark:text-rose-300 line-through',
          k === 'kept' && 'bg-black/[0.05] dark:bg-white/10 text-ink-secondary')}>
          {k === 'added' ? '+ ' : k === 'removed' ? '− ' : ''}{t}
        </span>
      ))}
    </span>
  )
}

const isTags = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

export const ReviewValue = memo(function ReviewValue({ field, plain = false }: {
  field: FieldChange
  /** Every row is the same kind (an entity added or removed whole): the badge would only repeat it. */
  plain?: boolean
}) {
  const style = KIND_STYLE[field.kind]
  const tags = (field.kind === 'changed' && isTags(field.before) && isTags(field.after))
    || (field.kind === 'added' && isTags(field.after)) || (field.kind === 'removed' && isTags(field.before))
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr] gap-3 px-3 py-2 border-b border-glass-border/50 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-ink truncate">{field.label}</span>
        </div>
        {(!plain || field.folder) && (
          <div className="flex items-center gap-1.5 mt-0.5">
            {!plain && <span className={cn('px-1 py-px rounded text-[9px] font-bold uppercase tracking-wide', style.badge)}>{style.label}</span>}
            {field.folder && <span className="text-2xs text-ink-muted truncate">in {field.folder}</span>}
          </div>
        )}
      </div>
      <div className="min-w-0 flex items-start gap-2 flex-wrap">
        {tags ? (
          <TagDiff before={isTags(field.before) ? field.before : []} after={isTags(field.after) ? field.after : []} />
        ) : field.kind === 'changed' ? (
          <>
            <Value value={field.before} gone />
            <ArrowRight className="w-3.5 h-3.5 mt-0.5 text-ink-muted shrink-0" aria-label="becomes" />
            <Value value={field.after} />
          </>
        ) : field.kind === 'added' ? (
          <Value value={field.after} />
        ) : (
          <Value value={field.before} gone />
        )}
      </div>
    </div>
  )
})
