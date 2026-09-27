/** Kbd — a keyboard shortcut, written the way this platform writes it (`⌘S` / `Ctrl+S`). */
import { cn } from '@/lib/utils'
import { formatShortcut } from '@/lib/platform'

export function Kbd({ shortcut, className, tone = 'default' }: {
  /** `"mod+s"`-style; `mod` is ⌘ on Apple, Ctrl elsewhere. */
  shortcut: string
  className?: string
  /** `onAccent` for a shortcut shown on a primary (filled) button. */
  tone?: 'default' | 'onAccent'
}) {
  return (
    <kbd className={cn(
      'inline-flex items-center h-[18px] px-1 rounded font-sans text-[10px] font-semibold leading-none tabular-nums',
      tone === 'onAccent' ? 'bg-white/20 text-white' : 'bg-black/[0.06] dark:bg-white/10 text-ink-muted border border-glass-border',
      className,
    )}>
      {formatShortcut(shortcut)}
    </kbd>
  )
}
