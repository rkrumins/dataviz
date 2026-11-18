/**
 * EntityChangeDigest — what a draft has done to this entity (or relationship), in one line at the top of its details,
 * in the tree's colours: "In this draft · Edited owner, tier and 1 more ~2 +1", and how many fields
 * are staged but not saved yet. Saved changes come from the draft against what is published;
 * nothing shows for an entity the draft has not touched.
 */
import { memo, useMemo } from 'react'
import { GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ChangeSummary } from '@/features/versioning/components/ChangeSummary'
import { fieldsOfChange, summarizeFields } from '@/features/versioning/model/fieldDiff'
import { CHANGE_TONE, STATE_DOT } from '@/features/versioning/model/changeTone'
import type { EntityBaseline } from '@/features/versioning/hooks/useEntityBaseline'

export const EntityChangeDigest = memo(function EntityChangeDigest({ baseline, unsavedFields, kind = 'node' }: {
  baseline: EntityBaseline | undefined
  /** Fields staged on it, not saved yet. */
  unsavedFields: number
  /** An entity's or a relationship's. */
  kind?: 'node' | 'edge'
}) {
  const status = baseline && baseline.status !== 'unchanged' ? baseline.status : null
  const summary = useMemo(() => {
    if (!baseline || !status) return null
    return summarizeFields(fieldsOfChange({
      entityId: '', kind, status, label: '', origin: { source: 'branch', branchId: '' },
      before: status === 'added' ? undefined : baseline.published,
      after: baseline.saved ?? undefined,
    }))
  }, [baseline, status, kind])
  if (!status && !unsavedFields) return null
  const tone = CHANGE_TONE[status ?? 'modified']
  return (
    <div role="status" className={cn('relative flex items-center gap-2 min-w-0 rounded-xl border pl-3.5 pr-3 py-2 mb-3', tone.soft, tone.border)}>
      <span aria-hidden className={cn('absolute left-0 top-2 bottom-2 w-[3px] rounded-full', tone.bar)} />
      <GitBranch className={cn('w-3.5 h-3.5 shrink-0', tone.text)} aria-hidden />
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted shrink-0">In this draft</span>
      {status
        ? <ChangeSummary summary={summary} status={status} className="flex-1 min-w-0" />
        : <span className="flex-1" />}
      {unsavedFields > 0 && (
        <span className="inline-flex items-center gap-1 shrink-0 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
          <span aria-hidden className={cn('w-1.5 h-1.5 rounded-full', STATE_DOT.unsaved)} />
          {unsavedFields.toLocaleString()} not saved yet
        </span>
      )}
    </div>
  )
})
