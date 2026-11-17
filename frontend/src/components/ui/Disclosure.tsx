/**
 * Disclosure — a heading that opens what is under it. The button says whether it is open
 * (`aria-expanded`) and what it opens (`aria-controls`); what is under it is only mounted while open,
 * so a closed section costs nothing.
 */
import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Disclosure({ summary, defaultOpen = false, open: controlled, onOpenChange, children, className, buttonClassName }: {
  summary: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
  className?: string
  buttonClassName?: string
}) {
  const [own, setOwn] = useState(defaultOpen)
  const open = controlled ?? own
  const id = useId()
  const set = (next: boolean) => { if (controlled === undefined) setOwn(next); onOpenChange?.(next) }
  return (
    <div className={className}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => set(!open)}
        className={cn('w-full flex items-center gap-1.5 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40', buttonClassName)}>
        <ChevronRight className={cn('w-3.5 h-3.5 text-ink-muted/70 shrink-0 motion-safe:transition-transform', open && 'rotate-90')} aria-hidden />
        {summary}
      </button>
      {open && <div id={id}>{children}</div>}
    </div>
  )
}
