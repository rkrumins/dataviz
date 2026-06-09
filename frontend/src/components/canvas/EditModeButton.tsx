/**
 * EditModeButton — the single, deliberate gateway from Explore into Edit mode.
 *
 * Shared so the affordance is identical everywhere it appears: the Context View
 * header's Explore row and the floating top-left clusters on the Graph /
 * Hierarchy canvases. Intentionally understated (ghost/outlined) so it reads as
 * "switch into authoring" rather than a primary call-to-action.
 */
import { Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'

export function EditModeButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      title="Edit the graph — add entities, draw relationships, and save a blueprint"
      className={cn(
        'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-300',
        'bg-canvas-elevated/80 backdrop-blur text-ink-muted border border-black/[0.12] dark:border-white/[0.10]',
        'hover:text-accent-lineage hover:border-accent-lineage/45 hover:bg-accent-lineage/[0.06]',
        'hover:shadow-sm hover:shadow-accent-lineage/10 active:scale-[0.98]',
        className,
      )}
    >
      <Pencil className="w-4 h-4" strokeWidth={2.2} />
      <span>Edit</span>
    </button>
  )
}
