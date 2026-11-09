import { motion } from 'framer-motion'
import { Briefcase, Code2 } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { usePersonaStore } from '@/store/persona'
import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'
import { formatShortcut, isApplePlatform } from '@/lib/platform'
import { onRadioGroupKeyDown } from '@/lib/radioGroupKeys'

/** Each view's tint. The accents are too light for text on white (about 2.5:1
 *  and 2.1:1), so the chosen label takes a deeper step of the same hue. */
const OPTIONS = [
  {
    mode: 'business',
    label: 'Business',
    icon: Briefcase,
    text: 'text-emerald-700 dark:text-emerald-400',
    focus: 'focus-visible:ring-accent-business/40',
    thumb: 'to-emerald-50 ring-accent-business/30 dark:from-accent-business/20 dark:to-accent-business/10 dark:ring-accent-business/40',
  },
  {
    mode: 'technical',
    label: 'Technical',
    icon: Code2,
    text: 'text-amber-700 dark:text-amber-300',
    focus: 'focus-visible:ring-accent-technical/40',
    thumb: 'to-amber-50 ring-accent-technical/30 dark:from-accent-technical/20 dark:to-accent-technical/10 dark:ring-accent-technical/40',
  },
] as const

/**
 * PersonaToggle - Switch between the Business and Technical views
 *
 * Business: the essentials. Menus and toolbars keep to what reading a view
 * needs — the rest waits under More — and an entity reads by the name a person
 * recognises: a curated `businessLabel` override when one exists, otherwise
 * its display name.
 * Technical: every tool on every row, and each entity's identifier revealed
 * under its name — the identifier property its data source keys entities by
 * (such as `id`), or its URN. Applies to context-view rows, graph node cards
 * and the entity drawer. `lib/entityDisplayName.ts` owns the naming rule; the
 * tip below must keep naming what each view actually does.
 */
export function PersonaToggle() {
  const mode = usePersonaStore((s) => s.mode)
  const setMode = usePersonaStore((s) => s.setMode)
  // ⌘/ itself is AppLayout's, so it works from anywhere; each option says so.
  const keyshortcuts = isApplePlatform() ? 'Meta+/' : 'Control+/'

  // The shared helper moves by arrow keys only; Home and End are this group's.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Home' && e.key !== 'End') return onRadioGroupKeyDown(e)
    e.preventDefault()
    const radios = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')
    const to = radios[e.key === 'Home' ? 0 : radios.length - 1]
    to.focus()
    to.click()
  }

  return (
    <HoverTip
      className="inline-flex"
      width="data"
      label={
        <span className="block space-y-1">
          <span className="block"><strong className="font-semibold">Business</strong> keeps the essentials: fewer tools, names as people say them.</span>
          <span className="block"><strong className="font-semibold">Technical</strong> adds every tool, and each entity’s identifier under its name.</span>
        </span>
      }
      detail="Same graph either way"
      shortcut={formatShortcut('mod+/')}
    >
      <div
        role="radiogroup"
        aria-label="Business or Technical view"
        onKeyDown={onKeyDown}
        className={cn(
          // Equal columns, so the thumb is the same shape under either label —
          // and never narrower than the labels: `grid-cols-2` tracks can
          // shrink to nothing, and a crowded top bar would squeeze them.
          'inline-grid h-9 min-w-max grid-cols-2 rounded-xl p-1',
          'bg-slate-100/90 ring-1 ring-inset ring-slate-200/80 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)]',
          'dark:bg-white/[0.04] dark:ring-white/[0.07]',
        )}
      >
        {OPTIONS.map((o) => {
          const checked = o.mode === mode
          const Icon = o.icon
          return (
            <button
              key={o.mode}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-keyshortcuts={keyshortcuts}
              tabIndex={checked ? 0 : -1}
              onClick={() => setMode(o.mode)}
              className={cn(
                'relative inline-flex items-center justify-center gap-1.5 rounded-lg px-3',
                'text-[13px] font-medium transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2',
                o.focus,
                checked ? o.text : 'text-ink-muted hover:text-ink-secondary',
              )}
            >
              {/* One thumb, handed to the chosen option, so it slides across. */}
              {checked && (
                <motion.span
                  layoutId="persona-thumb"
                  transition={{ type: 'spring', bounce: 0.16, duration: 0.36 }}
                  className={cn(
                    'absolute inset-0 rounded-lg ring-1 ring-inset bg-gradient-to-b from-white',
                    'shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.9)]',
                    // The white top edge is light-only; on a dark thumb it reads as a hard rim.
                    'dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.08)]',
                    o.thumb,
                  )}
                />
              )}
              {/* A small pop as the view is chosen: transform only. */}
              <motion.span
                className="relative"
                initial={false}
                animate={checked ? { scale: [0.8, 1.12, 1], rotate: [-12, 6, 0] } : { scale: 1, rotate: 0 }}
                transition={{ duration: 0.32, ease: 'easeOut' }}
              >
                <Icon className="h-4 w-4" />
              </motion.span>
              <span className="relative">{o.label}</span>
            </button>
          )
        })}
      </div>
    </HoverTip>
  )
}

/**
 * Compact version for use in constrained spaces
 */
export function PersonaToggleCompact() {
  const { mode, toggleMode } = usePersonaStore()

  return (
    <button
      onClick={toggleMode}
      className={cn(
        "w-10 h-10 rounded-lg flex items-center justify-center",
        "transition-all duration-200",
        mode === 'business'
          ? "bg-accent-business/10 text-accent-business"
          : "bg-accent-technical/10 text-accent-technical"
      )}
      title={`${mode === 'business' ? 'Business' : 'Technical'} View - Click to switch`}
    >
      {mode === 'business' ? (
        <Briefcase className="w-5 h-5" />
      ) : (
        <Code2 className="w-5 h-5" />
      )}
    </button>
  )
}
