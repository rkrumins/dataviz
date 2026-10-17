/**
 * ReadRouteChip — says which store the canvas is reading from, straight from the watermark's
 * `readRoute` (the server's routing rule, not a guess from `fresh`).
 *
 * Published served from FalkorDB is the steady state and renders NOTHING, so the bar keeps its
 * `empty:hidden` on main. Published served from Postgres (the projection is catching up, or the
 * graph was unloaded) is transient and says so. A draft always says it: it is an overlay of the
 * draft's changes on whatever serves published, and the draft bar is shown anyway.
 */
import { Database } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'
import { useProjectionWatermark } from '../hooks/useVersioning'

export function ReadRouteChip({ workspaceId, graphId, isDraft }: {
  workspaceId: string
  graphId: string | null
  isDraft: boolean
}) {
  const wm = useProjectionWatermark(workspaceId, graphId).data
  const route = wm?.readRoute
  if (!graphId || !wm || !route) return null
  if (!isDraft && route.main === 'falkordb') return null

  const onFalkor = route.main === 'falkordb'
  const base = onFalkor
    ? `Serving from FalkorDB · ${wm.providerName ?? wm.providerId ?? 'Default graph store'}`
    : `Serving from Postgres (${wm.status === 'evicted' ? 'unloaded' : 'catching up'})`
  return (
    <HoverTip
      className="inline-flex"
      label={onFalkor
        ? 'Published is read from the fast read layer, which holds its latest version'
        : 'Published is read from the system of record until the fast read layer has it'}
      detail={isDraft
        ? 'This draft’s changes are laid over published as it is read'
        : 'Reads stay correct, only slower, until then'}
    >
      <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border border-glass-border">
        <Database className="w-3 h-3" />
        {isDraft ? `${base} · draft overlay` : base}
      </span>
    </HoverTip>
  )
}
