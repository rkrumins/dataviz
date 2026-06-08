/**
 * Field-level before/after detail for one changed entity. Replaces the raw
 * `JSON.stringify` blocks the old dialogs showed with a real two-column diff.
 */
import { cn } from '@/lib/utils'
import type { FieldDelta, GraphChange } from '../model/changeModel'

function fmt(v: unknown): string {
  if (v === undefined || v === null) return '—'
  if (typeof v === 'string') return v || '""'
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v)
      return s.length > 80 ? `${s.slice(0, 77)}…` : s
    } catch {
      return String(v)
    }
  }
  return String(v)
}

/** Present payload as key/value rows (for added/removed where there's only one side). */
function payloadRows(payload: Record<string, unknown> | undefined): FieldDelta[] {
  if (!payload) return []
  return Object.entries(payload)
    .filter(([k]) => !k.startsWith('_'))
    .map(([field, v]) => ({ field, before: undefined, after: v }))
    .sort((a, b) => a.field.localeCompare(b.field))
}

export function EntityDiff({ change }: { change: GraphChange }) {
  const rows: FieldDelta[] =
    change.status === 'modified'
      ? change.fields ?? []
      : change.status === 'added'
      ? payloadRows(change.after)
      : payloadRows(change.before)

  if (rows.length === 0) {
    return <p className="text-[11px] text-ink-muted px-2 py-1.5">No field-level detail.</p>
  }

  const twoSided = change.status === 'modified'
  return (
    <div className="rounded-lg border border-glass-border/60 overflow-hidden">
      {rows.map((r) => (
        <div
          key={r.field}
          className="grid grid-cols-[minmax(0,7rem)_1fr] gap-2 px-2.5 py-1.5 text-[11px] border-b border-glass-border/40 last:border-b-0"
        >
          <span className="font-medium text-ink-muted truncate" title={r.field}>
            {r.field}
          </span>
          {twoSided ? (
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="text-rose-500/90 line-through truncate" title={fmt(r.before)}>
                {fmt(r.before)}
              </span>
              <span className="text-ink-muted">→</span>
              <span className="text-emerald-500/90 truncate" title={fmt(r.after)}>
                {fmt(r.after)}
              </span>
            </span>
          ) : (
            <span
              className={cn(
                'truncate',
                change.status === 'removed' ? 'text-rose-500/90 line-through' : 'text-ink',
              )}
              title={fmt(r.after)}
            >
              {fmt(r.after)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
