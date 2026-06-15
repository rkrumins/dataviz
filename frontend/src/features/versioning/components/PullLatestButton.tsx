/**
 * PullLatestButton — "pull the latest main into this draft", with in-place conflict resolution.
 *
 * Used on the canvas surfaces (BranchSwitcher rows + CanvasVersioningBar) where a draft can fall
 * behind main. Owns the full pull → {clean:false} → ConflictResolver → re-call loop, so each call
 * site is one line. Renders nothing unless `behind`. (PrDetailDrawer keeps its own flow — it
 * interleaves merge- and pull-resolve modes.)
 *
 * The diff (used to seed conflict resolutions) is fetched lazily — only after the first Pull click —
 * so a switcher listing many behind drafts doesn't fan out a diff request per row.
 */
import { useMemo, useState } from 'react'
import { ArrowDownToLine, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import type { ResolutionMap } from '@/services/versioningApiService'
import { ConflictResolver } from '@/features/reviews/components/ConflictResolver'
import { useDiffVsMain, usePullLatestDraft } from '../hooks/useVersioning'

const VARIANTS = {
  row: 'shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-accent-lineage hover:bg-canvas-base disabled:opacity-50',
  bar: 'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-amber-600 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-50',
  manager: 'shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-50',
} as const

// Plain-language labels (see branchVocab): "pull/rebase" reads as "get the latest updates".
const IDLE_LABEL = { row: 'Update', bar: 'Get latest updates', manager: 'Get latest' } as const

export function PullLatestButton({
  wsId, graphId, branchId, behind, variant = 'row', className,
}: {
  wsId: string
  graphId: string
  branchId: string
  behind: boolean
  variant?: keyof typeof VARIANTS
  className?: string
}) {
  const { showToast } = useToast()
  const pull = usePullLatestDraft(wsId, graphId)
  const [started, setStarted] = useState(false)
  const [conflicts, setConflicts] = useState<Array<Record<string, unknown>> | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Lazy: the diff only loads once a Pull is in flight. Seeds are read at resolve-submit time, by
  // when the diff has arrived. entityId → merged payload (the diff `after`), as in PrDetailDrawer.
  const diffQ = useDiffVsMain(wsId, graphId, started ? branchId : null)
  const seeds = useMemo(() => {
    const out: Record<string, Record<string, unknown> | undefined> = {}
    const d = diffQ.data
    if (d) for (const e of [...d.added, ...d.modified]) out[e.entityId] = (e.after as Record<string, unknown>) ?? undefined
    return out
  }, [diffQ.data])

  const run = (resolutions?: ResolutionMap) => {
    setStarted(true)
    pull.mutate(
      { branchId, resolutions },
      {
        onSuccess: (res) => {
          if (res.clean) {
            setConflicts(null); setError(null); setStarted(false)
            showToast('success', res.alreadyUpToDate ? 'Already up to date with main.' : 'Pulled the latest changes from main.')
          } else {
            setConflicts(res.conflicts)
            setError(resolutions ? 'Some fields still conflict — adjust and retry.' : null)
          }
        },
        onError: (e) => { setError(null); showToast('error', (e as Error).message) },
      },
    )
  }

  if (!behind) return null

  return (
    <>
      <button
        onClick={() => run()}
        disabled={pull.isPending}
        title="Get the latest updates from the published version into this draft"
        className={cn(VARIANTS[variant], className)}
      >
        {pull.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowDownToLine className="w-3.5 h-3.5" />}
        {pull.isPending ? (variant === 'row' ? 'Updating' : 'Updating…') : IDLE_LABEL[variant]}
      </button>

      {conflicts && (
        <ConflictResolver
          conflicts={conflicts}
          seeds={seeds}
          busy={pull.isPending}
          error={error}
          onCancel={() => { setConflicts(null); setError(null); setStarted(false) }}
          onResolve={(resolutions) => run(resolutions)}
        />
      )}
    </>
  )
}
