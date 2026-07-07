/**
 * AggregationSyncChip — makes the publish → aggregation pipeline visible on manual
 * (blank) models: when the published head advances while the bar is mounted, show a
 * transient "Syncing lineage rollups → Synced" chip driven by the same readiness
 * endpoint the Explorer's AggregationProgressBanner polls. Quietly disappears on
 * timeout or error — it is a reassurance surface, never a blocker.
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { aggregationService } from '@/services/aggregationService'

const POLL_MS = 5_000
const MAX_POLLS = 24          // ~2 minutes, then go quiet
const SYNCED_LINGER_MS = 6_000

interface AggregationSyncChipProps {
  dataSourceId: string
  /** The graph's published head — an increase means a publish/merge just landed. */
  mainHeadSeq: number
  /** Gate to blank/manual models — provider-backed sources have their own banner. */
  enabled: boolean
}

export function AggregationSyncChip({ dataSourceId, mainHeadSeq, enabled }: AggregationSyncChipProps) {
  const [phase, setPhase] = useState<'idle' | 'syncing' | 'synced'>('idle')
  const prevSeq = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) return
    const prev = prevSeq.current
    prevSeq.current = mainHeadSeq
    if (prev === null || mainHeadSeq <= prev) return   // first observation / no advance
    let cancelled = false
    let polls = 0
    setPhase('syncing')
    const tick = async () => {
      if (cancelled) return
      polls += 1
      try {
        const r = await aggregationService.getReadiness(dataSourceId)
        if (cancelled) return
        if (r.isReady && !r.activeJob) {
          setPhase('synced')
          setTimeout(() => { if (!cancelled) setPhase('idle') }, SYNCED_LINGER_MS)
          return
        }
      } catch {
        setPhase('idle')                               // readiness unavailable — go quiet
        return
      }
      if (polls >= MAX_POLLS) { setPhase('idle'); return }
      setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => { cancelled = true }
  }, [mainHeadSeq, dataSourceId, enabled])

  if (phase === 'idle') return null
  return phase === 'syncing' ? (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium text-indigo-500 bg-indigo-500/10 border border-indigo-500/20"
      title="Your published changes are being rolled up so cross-container lineage stays accurate"
    >
      <Loader2 className="w-3 h-3 animate-spin" />
      Syncing lineage rollups…
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium text-emerald-500 bg-emerald-500/10 border border-emerald-500/20"
      title="Cross-container lineage is up to date"
    >
      <CheckCircle2 className="w-3 h-3" />
      Lineage synced
    </span>
  )
}
