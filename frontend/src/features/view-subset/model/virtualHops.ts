/**
 * What the status cluster needs to know about a board's virtual hops.
 */
import type { LineageBridgesStatus } from '../hooks/useLineageBridges'

/** One virtual-hop line on the board, as the list names it. */
export interface VirtualHopLine {
  lineId: string
  sourceLabel: string
  targetLabel: string
  /** The shortest link the line stands for, in raw lineage edges. */
  hops: number
}

export interface VirtualHopsSummary {
  status: LineageBridgesStatus
  /** A refresh is running behind the lines on screen. */
  isFetching: boolean
  lines: readonly VirtualHopLine[]
  /** Members whose links may be missing, by name (only when `partial`). */
  incompleteNames: readonly string[]
  /** Part of the walk did not finish in time, so asking again may help —
   *  as opposed to lineage too large to walk, which asking again will not. */
  retryable: boolean
  maxHops: number
  onOpenLine: (lineId: string, point: { x: number; y: number }) => void
  onRetry: () => void
}

/** Whether the chip has anything to say: nothing drawn and nothing wrong is
 *  silence, and so is a server that does not offer the walk. */
export function virtualHopsChipVisible(summary: VirtualHopsSummary | undefined): boolean {
  if (!summary) return false
  switch (summary.status) {
    case 'loading':
    case 'error':
    case 'oversized':
    case 'partial':
      return true
    case 'ready':
      return summary.lines.length > 0
    default:
      return false
  }
}
