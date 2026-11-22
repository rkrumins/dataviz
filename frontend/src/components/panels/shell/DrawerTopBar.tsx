/**
 * DrawerTopBar — the first row of both drawers: the back/forward trail, what kind of thing is
 * shown (a badge), the drawer's one action where it has one ("Edit in a draft"), and close.
 * Close goes through the store's gate like any other move.
 */
import type { ReactNode } from 'react'
import { GitBranchPlus, X } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { DrawerTrailNav } from '../DrawerTrailNav'

export function DrawerTopBar({ badge, action, closeLabel, onClose, onFocusNode }: {
  badge: ReactNode
  /** Shown just before Close. */
  action?: ReactNode
  /** Names what closes, e.g. "Close entity details". */
  closeLabel: string
  onClose: () => void
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
}) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3">
      <div className="flex items-center gap-2 min-w-0">
        <DrawerTrailNav onFocusNode={onFocusNode} />
        {badge}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {action}
        <IconButton icon={X} label={closeLabel} shortcut="Esc" onClick={onClose} />
      </div>
    </div>
  )
}

/** The way into a draft, for a drawer that can't edit here — its tip says why not. */
export function EditInDraftButton({ onClick, reason }: { onClick: () => void; reason: string }) {
  return (
    <HoverTip label={reason} className="inline-flex">
      <Button size="sm" variant="secondary" leftIcon={GitBranchPlus} onClick={onClick}>Edit in a draft</Button>
    </HoverTip>
  )
}

/** A kind badge in an entity's or relationship's own colour. */
export function KindBadge({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <span className="px-2.5 py-1 rounded-lg text-xs font-semibold uppercase tracking-wide truncate" style={{ backgroundColor: bg, color: fg }}>
      {label}
    </span>
  )
}
