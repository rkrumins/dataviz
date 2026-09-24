/**
 * SubsetEntryButton — "Make a subset", in the view page header's quiet group.
 *
 * Opens the Subset Studio on the canvas below. Offered only where the server
 * says the reader may carve a subset out of this view (a Context View, and
 * the right to create views in its workspace) and subsets are switched on;
 * while a draft is open it explains why it waits, because a subset is made
 * from the published view.
 */
import { ScissorsLineDashed } from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'
import { useBranchStore } from '@/store/branchStore'

import { useSubsetStudioStore } from '../model/studioStore'

export function SubsetEntryButton({ viewId, maxHops, className }: {
  viewId: string
  /** The view's own reach, when it is itself a subset — carried over. */
  maxHops?: number
  className: string
}) {
  const studioOpen = useSubsetStudioStore((s) => s.sourceViewId === viewId)
  const draftOpen = useBranchStore((s) =>
    s.viewId === viewId && !!s.currentBranchId && s.currentBranchId !== s.mainBranchId)

  const toggle = () => {
    const store = useSubsetStudioStore.getState()
    if (studioOpen) store.requestCancel()
    else store.open(viewId, { maxHops })
  }

  return (
    <HoverTip
      className="inline-flex"
      label={draftOpen
        ? 'Leave the draft to make a subset'
        : studioOpen ? 'Leave the subset studio' : 'Make a smaller view out of this one'}
      detail={draftOpen
        ? 'A subset is made from the published view'
        : studioOpen ? undefined : 'Pick what to keep on the canvas — lineage between it stays connected'}
    >
      <button
        type="button"
        onClick={toggle}
        disabled={draftOpen}
        aria-pressed={studioOpen}
        aria-label="Subset"
        className={cn(className, studioOpen && 'text-accent-explore bg-accent-explore/10', 'disabled:opacity-40 disabled:cursor-not-allowed')}
      >
        <ScissorsLineDashed className="w-3.5 h-3.5" aria-hidden />
        <span className="hidden lg:inline">Subset</span>
      </button>
    </HoverTip>
  )
}
