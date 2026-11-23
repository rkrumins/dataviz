/**
 * ReadRouteChip — says which store the canvas is reading from, straight from the watermark's
 * `readRoute` (the server's routing rule, not a guess from `fresh`).
 *
 * Published served from FalkorDB at its latest version is the steady state and renders NOTHING,
 * so the bar keeps its `empty:hidden` on main. While the graph is written to a newer version,
 * FalkorDB serves the one it last finished (`served`), and the Technical view says which. Published
 * served from Postgres (the graph holds no version yet, or was unloaded) is transient and says so.
 * A draft always says it: it is an overlay of the
 * draft's changes on whatever serves published, and the draft bar is shown anyway. A fork reads
 * through its root's store; one too far from its parent to lay over (`readsFrom: 'postgres'`) is
 * served from Postgres until it is merged or catches up, and says why. While the newer version is
 * written and the server says how far it is (`progress`), the chip adds that: "63% · about 4 min
 * left".
 */
import { Database } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'
import { usePersonaMode } from '@/store/persona'
import { useProjectionWatermark } from '../hooks/useVersioning'
import { UpdateProgress } from './UpdateProgress'
import { describeProgress } from './updateProgressWords'

export function ReadRouteChip({ workspaceId, graphId, isDraft }: {
  workspaceId: string
  graphId: string | null
  isDraft: boolean
}) {
  const wm = useProjectionWatermark(workspaceId, graphId).data
  const technical = usePersonaMode() === 'technical'
  const route = wm?.readRoute
  if (!graphId || !wm || !route) return null
  // FalkorDB serving an earlier version of published, complete, while the newer one is written.
  const older = route.main === 'falkordb' && !wm.fresh && wm.served != null
  if (!isDraft && route.main === 'falkordb' && !older) return null
  // How far the newer version is, when the server can say: its percentage and time left. Not for a
  // fork too far from its parent to lay over it, whose reads its parent's update doesn't move.
  const progress = !wm.fresh && wm.readsFrom !== 'postgres' && wm.progress
    && describeProgress(wm.progress).bare ? wm.progress : null
  // The chip's words, then how far: on one line while there is room, beneath them when there isn't.
  const said = (words: string) => (progress ? (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span>{words}</span>
      <UpdateProgress progress={progress} variant="chip" withVersion={false} className="text-ink-secondary" />
    </span>
  ) : words)
  // The Business view names no store. FalkorDB serving published is the steady state there, under
  // a draft overlay too, and the header's sync chip says when it is an earlier version; Postgres
  // standing in for it means only that reads are slower for now.
  if (!technical) {
    if (route.main === 'falkordb') return null
    return (
      <HoverTip className="inline-flex" label="Reads stay correct while it catches up"
        detail={progress ? 'They may be slower until then' : undefined}>
        <span className="flex min-w-0 items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border border-glass-border">
          <Database className="w-3 h-3" />
          {progress ? said('Catching up') : 'Catching up — may be slower'}
        </span>
      </HoverTip>
    )
  }

  const onFalkor = route.main === 'falkordb'
  const farFork = !onFalkor && wm.readsFrom === 'postgres'
  const base = onFalkor
    ? older
      ? `Serving #${wm.served} from FalkorDB · #${wm.committed} being written`
      : `Serving from FalkorDB · ${wm.providerName ?? wm.providerId ?? 'Default graph store'}`
    : `Serving from Postgres (${farFork ? 'far from its parent' : wm.status === 'evicted' ? 'unloaded' : wm.status === 'idle' && wm.lastError ? 'retrying' : 'catching up'})`
  return (
    <HoverTip
      className="inline-flex"
      label={onFalkor
        ? older
          ? 'Published is read from the fast read layer at the version it last finished, while the newer one is written'
          : 'Published is read from the fast read layer, which holds its latest version'
        : farFork
          ? 'This fork changed too much since it parted from its parent to be laid over the parent’s fast read layer'
          : 'Published is read from the system of record until the fast read layer has it'}
      detail={isDraft
        ? 'This draft’s changes are laid over published as it is read'
        : older
          ? 'Reads stay complete and fast, and switch to the newer version once it is in'
          : farFork
            ? 'Reads stay correct, only slower, and search does not reach it'
            : 'Reads stay correct, only slower, until then'}
    >
      <span className="flex min-w-0 items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border border-glass-border">
        <Database className="w-3 h-3" />
        {said(isDraft ? `${base} · draft overlay` : base)}
      </span>
    </HoverTip>
  )
}
