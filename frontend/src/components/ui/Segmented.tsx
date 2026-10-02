/**
 * Segmented — pick one of a few options in place (a history's All / This draft / Published).
 * A radiogroup: one tab stop, arrow keys (and Home / End) move the choice, and each option can
 * carry a count.
 */
import { useRef, type ComponentType, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ComponentType<{ className?: string }>
  count?: number
  disabled?: boolean
}

export function Segmented<T extends string>({ options, value, onChange, label, size = 'sm', className }: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** The group's accessible name. */
  label: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0)

  const move = (e: KeyboardEvent, from: number) => {
    const at = enabled.indexOf(from)
    let to: number | undefined
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = enabled[(at + 1) % enabled.length]
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = enabled[(at - 1 + enabled.length) % enabled.length]
    else if (e.key === 'Home') to = enabled[0]
    else if (e.key === 'End') to = enabled[enabled.length - 1]
    if (to === undefined) return
    e.preventDefault()
    onChange(options[to].value)
    refs.current[to]?.focus()
  }

  return (
    <div role="radiogroup" aria-label={label}
      className={cn('inline-flex w-fit h-fit items-center gap-0.5 p-0.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.05]', className)}>
      {options.map((o, i) => {
        const on = o.value === value
        const Icon = o.icon
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
              'disabled:opacity-40 disabled:cursor-not-allowed',
              size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-8 px-3 text-xs',
              on ? 'bg-canvas-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            {Icon && <Icon className="w-3.5 h-3.5" aria-hidden />}
            {o.label}
            {o.count !== undefined && (
              <span className={cn('tabular-nums text-[10px] font-semibold', on ? 'text-ink-secondary' : 'text-ink-muted')}>
                {o.count.toLocaleString()}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
