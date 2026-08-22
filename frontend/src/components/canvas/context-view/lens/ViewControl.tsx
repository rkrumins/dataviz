/**
 * ViewControl — one category of how the Lens draws, as a chip that opens
 * its options (2026-08-22).
 *
 * The header used to carry six captioned segmented groups — Next · Walk ·
 * Steps · Density · Wires · direction — ~1,300px of buttons that crowded
 * the search box off the row at ordinary widths. "Break this down into
 * different categories that the user clicks and can control." Each
 * category is now ONE chip: an icon, the category's name, its CURRENT
 * value, a chevron. A click opens a menu in which every option carries
 * its name and a line of meaning — the choice is explained before it is
 * made, without hovering for it — and the current one is checked.
 *
 * Click to open, not hover: a menu that opens under a passing pointer is
 * the thing readers fight; the chip's own meaning is the hover. Radix
 * Popover for the surface (focus trap, Esc, outside click, no
 * AnimatePresence to strand), rendered above the Lens dialog.
 */
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import * as Popover from '@radix-ui/react-popover'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { ControlTip } from './ControlTip'

export interface ViewOption<V extends string> {
  value: V
  label: string
  /** One sentence: what choosing this does. Shown in the menu, always. */
  meaning: string
  Icon: LucideIcons.LucideIcon
}

export interface ViewControlProps<V extends string> {
  /** The category's name: "Density". */
  caption: string
  /** One sentence: what the category is about. Heads the menu; the chip's hover. */
  meaning: string
  value: V
  options: readonly ViewOption<V>[]
  onChange: (value: V) => void
  /** Where the menu opens; bottom-start by default. */
  align?: 'start' | 'end'
  /** A tour anchor for the chip — passed literally as `data-tour="…"` so the
   *  tour-anchor guard can see it in the source. */
  'data-tour'?: string
  className?: string
}

export function ViewControl<V extends string>({ caption, meaning, value, options, onChange, align = 'start', 'data-tour': tour, className }: ViewControlProps<V>) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const listRef = useRef<HTMLDivElement | null>(null)
  const current = options.find(o => o.value === value) ?? options[0]
  const CurrentIcon = current.Icon

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
    if (items.length === 0) return
    const at = items.findIndex(el => el === document.activeElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    items[next].focus()
    e.preventDefault()
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <ControlTip name={caption} meaning={meaning} quiet={open}>
        {(tip) => (
          <Popover.Trigger asChild>
            <button
              type="button"
              data-tour={tour}
              aria-label={`${caption}: ${current.label}`}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? menuId : undefined}
              aria-describedby={tip['aria-describedby']}
              className={cn(
                tip.peer,
                'group/chip flex items-center gap-1.5 h-7 pl-2 pr-1.5 rounded-lg border text-left whitespace-nowrap transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                open
                  ? 'border-accent-lineage/40 bg-accent-lineage/[0.08]'
                  : 'border-black/10 dark:border-white/10 bg-canvas-elevated hover:border-black/20 dark:hover:border-white/20 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]',
                className,
              )}
            >
              <CurrentIcon className="w-3 h-3 flex-shrink-0 text-accent-lineage" aria-hidden="true" />
              <span className="text-[9.5px] font-semibold uppercase tracking-wide text-ink-muted/70" aria-hidden="true">{caption}</span>
              <span className="text-[11px] font-semibold text-ink" aria-hidden="true">{current.label}</span>
              <LucideIcons.ChevronDown className={cn('w-3 h-3 flex-shrink-0 text-ink-muted/60 transition-transform', open && 'rotate-180')} aria-hidden="true" />
            </button>
          </Popover.Trigger>
        )}
      </ControlTip>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={6}
          className="z-[9999] w-[19rem] rounded-xl border border-black/10 dark:border-white/10 bg-canvas-elevated shadow-xl shadow-black/10 p-1.5 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-1"
          onOpenAutoFocus={(e) => {
            // Land on the current option, not the first.
            e.preventDefault()
            listRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
          }}
        >
          <div ref={listRef} id={menuId} role="menu" aria-label={caption} onKeyDown={onKeyDown} className="flex flex-col gap-0.5">
            <div role="presentation" className="px-2 pt-1 pb-1.5">
              <p className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-ink-muted/70">{caption}</p>
              <p className="text-[10.5px] text-ink-muted leading-snug">{meaning}</p>
            </div>
            {options.map(({ value: v, label, meaning: why, Icon }) => {
              const checked = v === value
              return (
                <button
                  key={v}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  onClick={() => { onChange(v); setOpen(false) }}
                  className={cn(
                    'flex items-start gap-2.5 w-full px-2 py-1.5 rounded-lg text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    checked
                      ? 'bg-accent-lineage/[0.08]'
                      : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
                  )}
                >
                  <span className={cn('mt-0.5 w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0', checked ? 'bg-accent-lineage/15 text-accent-lineage' : 'bg-black/[0.05] dark:bg-white/[0.08] text-ink-muted')}>
                    <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className={cn('block text-[11.5px] font-semibold leading-tight', checked ? 'text-accent-lineage' : 'text-ink')}>{label}</span>
                    <span className="block mt-0.5 text-[10.5px] text-ink-muted leading-snug">{why}</span>
                  </span>
                  {checked && <LucideIcons.Check className="mt-1 w-3.5 h-3.5 flex-shrink-0 text-accent-lineage" aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
