/**
 * NotificationBell — placeholder notification icon in the TopBar.
 * Renders a "coming soon" popover. Future-proofed with count prop.
 */
import { Bell } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'

interface NotificationBellProps {
  count?: number
}

export function NotificationBell({ count = 0 }: NotificationBellProps) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="btn btn-ghost p-2 rounded-lg relative">
          <Bell className="w-5 h-5 text-ink-secondary" />
          {count > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-red-500 text-[9px] text-white flex items-center justify-center font-bold leading-none">
              {count > 9 ? '9+' : count}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="w-72 bg-canvas-elevated border border-glass-border rounded-xl shadow-2xl p-6 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
          sideOffset={8}
          align="end"
        >
          <div className="text-center">
            <Bell className="w-8 h-8 text-ink-muted mx-auto mb-2" />
            <p className="text-sm font-medium text-ink">Notifications</p>
            <p className="text-xs text-ink-muted mt-1.5 leading-relaxed">
              Coming soon. You'll see alerts for view changes, lineage breaks, and workspace activity.
            </p>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
