/**
 * KeepCompleteChip — the one question a view that never said whether it is meant to show
 * everything is asked, in the slot UnplacedRootsChip uses. Asked only of someone who can edit
 * the view, and only when it holds every top-level entity of the types it is about today: from
 * that alone it can't be known whether it shows everything on purpose, or is a lens that
 * happens to.
 *
 * A quiet chip in the status cluster, and a small sheet with two answers — never chosen for the
 * reader:
 *   • Keep it complete — new top-level entities are offered here as they arrive;
 *   • No, only what's here — it is never offered them.
 * Either is saved on the view, and changed again when the view is edited.
 */
import { useState } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Sparkles } from 'lucide-react'

const CHIP_CLASS =
  'pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur-md ' +
  'border border-black/10 dark:border-white/10 shadow-md text-[11px] font-medium text-ink-muted bg-canvas-elevated/80 ' +
  'cursor-pointer hover:scale-105 active:scale-95 transition-transform'
const PRIMARY =
  'w-full px-2.5 py-1.5 rounded-md text-[11.5px] font-medium text-accent-lineage bg-accent-lineage/10 hover:bg-accent-lineage/15 ' +
  'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'
const QUIET =
  'w-full px-2.5 py-1.5 rounded-md text-[11.5px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] ' +
  'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'
const HINT = 'pt-1 text-[10.5px] text-ink-muted leading-snug'

export interface KeepCompleteChipProps {
  /** The data source's name, when known. */
  sourceName?: string
  onKeep: () => void
  onOnlyHere: () => void
}

export function KeepCompleteChip({ sourceName, onKeep, onOnlyHere }: KeepCompleteChipProps) {
  const [open, setOpen] = useState(false)
  const act = (fn: () => void) => { setOpen(false); fn() }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className={CHIP_CLASS}>
          <Sparkles className="w-3 h-3 text-sky-500/80" aria-hidden />
          <span>Keep this view complete?</span>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="end"
          sideOffset={6}
          className="z-[9999] w-80 rounded-lg border border-glass-border bg-canvas-elevated shadow-xl shadow-black/40 p-3"
        >
          <p className="text-[12px] font-semibold text-ink">This view shows everything in {sourceName || 'this source'}.</p>
          <p className="pt-1 text-[11px] text-ink-muted leading-relaxed">Keep it complete as new top-level entities arrive?</p>

          <div className="mt-3 pt-3 border-t border-glass-border/60 space-y-3">
            <div>
              <button type="button" className={PRIMARY} onClick={() => act(onKeep)}>Keep it complete</button>
              <p className={HINT}>New ones are offered here as they arrive. Nothing is added unless you choose.</p>
            </div>
            <div>
              <button type="button" className={QUIET} onClick={() => act(onOnlyHere)}>No, only what’s here</button>
              <p className={HINT}>New ones are never offered. Change it any time by editing the view.</p>
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
