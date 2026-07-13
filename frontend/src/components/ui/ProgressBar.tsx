/**
 * ProgressBar — the app's determinate progress track (extracted from DataHealthTab,
 * which had it inline). Always shows a sliver at 0% so a just-started job reads as
 * "running", not "stuck".
 */
import { cn } from '@/lib/utils'

export function ProgressBar({
  value,
  className,
  barClassName,
  label,
}: {
  /** 0–100. Clamped. */
  value: number
  className?: string
  barClassName?: string
  /** Accessible name, e.g. "Copying the graph". */
  label?: string
}) {
  const pct = Math.min(100, Math.max(0, Math.round(value)))
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('h-1.5 rounded-full bg-canvas-overlay overflow-hidden', className)}
    >
      <div
        className={cn(
          'h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-600 transition-[width] duration-700 ease-out',
          barClassName,
        )}
        style={{ width: `${Math.max(2, pct)}%` }}
      />
    </div>
  )
}
