/**
 * ChangePeek — what changed on an entity, on hover, wherever the canvas marks it as changed: its
 * status in the tree's colours, whether it is saved in the draft or only staged, a line saying what
 * it changed ("Edited owner, tier and 1 more"), and its first few fields before → after.
 *
 * A staged change is told from memory. A saved one is read from the draft — after a moment of
 * hovering, never for a pointer passing over — and kept (the change list's cache), so a second look
 * costs nothing; reading it shows a placeholder, failing says so. Keyboard focus opens it too (it is
 * a HoverTip).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { StagedChange } from '@/store/stagedChangesStore'
import type { EntityDecoration } from '@/features/versioning/canvas/useDiffDecoration'
import { useChangeEntry } from '@/features/versioning/hooks/useVersioning'
import { fieldChanges } from '@/features/versioning/model/reviewModel'
import { fieldsOfChange, keyDifferences, summarizeFields } from '@/features/versioning/model/fieldDiff'
import { CHANGE_TONE, STATE_DOT, fieldTone } from '@/features/versioning/model/changeTone'
import { ChangeSummary } from '@/features/versioning/components/ChangeSummary'
import { shortValue } from '@/components/panels/property/changeMarks'
import { useDrawerHistoryScope } from '@/components/panels/useDrawerHistoryScope'

/** How long the pointer rests before a saved change is read. */
const READ_AFTER_MS = 250
/** Fields shown before → after. */
const ROWS = 4

export function ChangePeek({ entityId, deco, staged, children, className }: {
  entityId: string
  deco: EntityDecoration
  /** Its latest staged change, when it has one. */
  staged?: StagedChange
  children: ReactNode
  className?: string
}) {
  return (
    <HoverTip width="data" className={className} label={<PeekCard entityId={entityId} deco={deco} staged={staged} />}>
      {children}
    </HoverTip>
  )
}

function PeekCard({ entityId, deco, staged }: { entityId: string; deco: EntityDecoration; staged?: StagedChange }) {
  const tone = CHANGE_TONE[deco.status]
  const unsaved = deco.state === 'staged'
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), READ_AFTER_MS)
    return () => window.clearTimeout(t)
  }, [])
  const scope = useDrawerHistoryScope()
  const draftId = scope.branchId && scope.branchId !== scope.mainBranchId ? scope.branchId : null
  const origin = useMemo(() => (draftId && !unsaved && armed ? { branchId: draftId } : null), [draftId, unsaved, armed])
  const entry = useChangeEntry(scope.wsId, scope.graphId, origin, entityId)

  const fields = useMemo(() => {
    if (unsaved) return staged ? fieldChanges(staged) : null
    const d = entry.data
    if (!d || d.status === 'unchanged') return null
    return fieldsOfChange({
      entityId, kind: d.kind, status: d.status, label: '', origin: { source: 'branch', branchId: draftId ?? '' },
      before: d.before ?? undefined, after: d.after ?? undefined,
    })
  }, [unsaved, staged, entry.data, entityId, draftId])
  const summary = useMemo(() => (fields ? summarizeFields(fields) : null), [fields])
  const rows = useMemo(() => (fields && deco.status === 'modified' ? keyDifferences(fields, ROWS) : []), [fields, deco.status])
  const reading = !unsaved && !fields && !entry.isError && !!draftId

  return (
    <span className="block space-y-1.5 text-left">
      <span className="flex items-center gap-1.5">
        <span className={cn('px-1.5 py-px rounded text-[10px] font-bold uppercase tracking-wide', tone.chip)}>{tone.verb}</span>
        <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-muted">
          <span aria-hidden className={cn('w-1.5 h-1.5 rounded-full', tone.text, STATE_DOT[unsaved ? 'unsaved' : 'saved'])} />
          {unsaved ? 'Not saved yet' : 'Saved in this draft'}
        </span>
      </span>
      {summary ? (
        <ChangeSummary summary={summary} status={deco.status} fallback={staged?.summary} />
      ) : reading ? (
        <span className="block h-3 w-40 rounded bg-black/[0.06] dark:bg-white/[0.08] motion-safe:animate-pulse" aria-label="Reading what changed" />
      ) : entry.isError ? (
        <span className="block text-[11px] text-ink-muted">Couldn’t load what changed.</span>
      ) : staged?.summary ? (
        <span className="block text-[11.5px] text-ink-secondary">{staged.summary}</span>
      ) : null}
      {rows.length > 0 && (
        <span className="block space-y-0.5">
          {rows.map((f, i) => (
            <span key={`${f.folder ?? ''}/${f.label}/${i}`} className="flex items-center gap-1.5 min-w-0 text-[11px]">
              <span className={cn('shrink-0 font-semibold', fieldTone(f.kind).text)}>{f.label}</span>
              {f.kind !== 'added' && <span className="truncate text-ink-muted line-through decoration-rose-400/60">{shortValue(f.before)}</span>}
              {f.kind === 'changed' && <ArrowRight className="w-3 h-3 shrink-0 text-ink-muted/70" aria-label="to" />}
              {f.kind !== 'removed' && <span className="truncate text-ink">{shortValue(f.after)}</span>}
            </span>
          ))}
        </span>
      )}
      <span className="block text-[10.5px] text-ink-muted">Click it to open its details.</span>
    </span>
  )
}
