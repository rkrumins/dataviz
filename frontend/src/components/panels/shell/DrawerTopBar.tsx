/**
 * DrawerTopBar — the first row of both drawers: the back/forward trail, what kind of thing is
 * shown (a badge), and close. Close goes through the store's gate like any other move.
 */
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { IconButton } from '@/components/ui/Button'
import { DrawerTrailNav } from '../DrawerTrailNav'

export function DrawerTopBar({ badge, closeLabel, onClose, onFocusNode }: {
  badge: ReactNode
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
      <IconButton icon={X} label={closeLabel} shortcut="Esc" onClick={onClose} />
    </div>
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
