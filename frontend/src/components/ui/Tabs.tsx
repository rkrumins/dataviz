/**
 * Tabs — Radix Tabs with the app's look: a segmented strip (a drawer's View / Edit / JSON) or an
 * underline row. Keyboard, roving focus and ARIA come from Radix; a trigger can carry an icon and
 * a badge (an unsaved-changes dot, a count).
 *
 * A strip that may hold more tabs than its width (a drawer on a phone, a page with many sections)
 * is `scrollable`: its tabs keep their size and the strip scrolls sideways — by touch, trackpad,
 * the scrollbar or the mouse wheel — with a fade on the side that has more, and the active tab is
 * always brought into view, so a link that opens a later tab lands with it showing.
 */
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore,
  type ComponentType, type ReactNode, type RefObject,
} from 'react'
import * as RadixTabs from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

type TabsLook = 'segmented' | 'underline'
const LookContext = createContext<TabsLook>('segmented')
const ScrollableContext = createContext(false)

export function Tabs(props: RadixTabs.TabsProps) {
  return <RadixTabs.Root {...props} />
}

/** Room either side of a tab brought into view, so it isn't flush with a fade. */
const REVEAL_MARGIN = 24

/** Scroll ``list`` (and only it) so ``tab`` is in view, measuring by layout — which a drawer's
 *  slide-in transform doesn't move — not by the box on screen. The strip is its tabs' offset
 *  parent, so a tab's ``offsetLeft`` is where it sits in the strip's scrolled content. */
function reveal(list: HTMLElement, tab: HTMLElement) {
  const start = tab.offsetLeft
  const end = start + tab.offsetWidth
  if (start < list.scrollLeft + REVEAL_MARGIN) list.scrollLeft = Math.max(0, start - REVEAL_MARGIN)
  else if (end > list.scrollLeft + list.clientWidth - REVEAL_MARGIN) list.scrollLeft = end - list.clientWidth + REVEAL_MARGIN
}

/** Which sides of a sideways scroller have more to show: `"left|right"`, each `1` or `0`. A string,
 *  because `useSyncExternalStore` compares snapshots by identity. */
function useOverflowSides(ref: RefObject<HTMLElement | null>, enabled: boolean): { left: boolean; right: boolean } {
  const subscribe = useCallback((onChange: () => void) => {
    const el = enabled ? ref.current : null
    if (!el) return () => {}
    el.addEventListener('scroll', onChange, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onChange) : null
    ro?.observe(el)
    for (const child of Array.from(el.children)) ro?.observe(child)
    return () => { el.removeEventListener('scroll', onChange); ro?.disconnect() }
  }, [ref, enabled])
  const snapshot = useSyncExternalStore(subscribe, () => {
    const el = enabled ? ref.current : null
    if (!el) return '0|0'
    const more = el.scrollWidth - el.clientWidth
    return `${el.scrollLeft > 1 ? 1 : 0}|${more > 1 && el.scrollLeft < more - 1 ? 1 : 0}`
  }, () => '0|0')
  const [left, right] = snapshot.split('|')
  return { left: left === '1', right: right === '1' }
}

export function TabsList({ look = 'segmented', scrollable = false, className, children, ...rest }: RadixTabs.TabsListProps & {
  look?: TabsLook
  /** Scroll sideways rather than squeeze or spill when the tabs are wider than the strip. */
  scrollable?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const sides = useOverflowSides(ref, scrollable)
  const shown = useRef<Element | null>(null)
  // Until the reader moves the strip themselves, it follows the active tab as its tabs settle to
  // their final widths (web fonts arriving, a count loading): measured once, it could land short.
  const follow = useRef(true)
  const activeTab = () => ref.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]') ?? null

  // Bring the active tab into view when it changes (and on first paint), scrolling only the strip —
  // never the page or the drawer around it.
  useLayoutEffect(() => {
    const list = ref.current
    const active = activeTab()
    if (!scrollable || !list || !active || active === shown.current) return
    shown.current = active
    follow.current = true
    reveal(list, active)
  })

  // ... and keep it there while the strip settles.
  useEffect(() => {
    const list = ref.current
    if (!scrollable || !list || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const active = activeTab()
      if (active && follow.current) reveal(list, active)
    })
    ro.observe(list)
    for (const child of Array.from(list.children)) ro.observe(child)
    const letGo = () => { follow.current = false }
    for (const type of ['wheel', 'touchstart', 'pointerdown'] as const) list.addEventListener(type, letGo, { passive: true })
    return () => {
      ro.disconnect()
      for (const type of ['wheel', 'touchstart', 'pointerdown'] as const) list.removeEventListener(type, letGo)
    }
  }, [scrollable])

  // A mouse wheel scrolls the strip sideways while it has further to go that way; at either end
  // the page scrolls as usual.
  useEffect(() => {
    const list = ref.current
    if (!scrollable || !list) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || list.scrollWidth <= list.clientWidth) return
      const before = list.scrollLeft
      list.scrollLeft += e.deltaY
      if (list.scrollLeft !== before) e.preventDefault()
    }
    list.addEventListener('wheel', onWheel, { passive: false })
    return () => list.removeEventListener('wheel', onWheel)
  }, [scrollable])

  const strip = (
    <RadixTabs.List
      ref={ref}
      className={cn(
        look === 'segmented'
          ? 'flex items-center gap-1 p-1 rounded-xl bg-black/[0.05] dark:bg-white/[0.05]'
          : 'flex items-center gap-4 border-b border-glass-border',
        scrollable && 'relative overflow-x-auto overflow-y-hidden custom-scrollbar',
        className,
      )}
      {...rest}
    >
      {children}
    </RadixTabs.List>
  )

  return (
    <LookContext.Provider value={look}>
      <ScrollableContext.Provider value={scrollable}>
        {scrollable ? (
          <div className="relative min-w-0">
            {strip}
            <span aria-hidden data-tabs-fade="left" className={cn(
              'pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-canvas to-transparent transition-opacity duration-150',
              sides.left ? 'opacity-100' : 'opacity-0')} />
            <span aria-hidden data-tabs-fade="right" className={cn(
              'pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-canvas to-transparent transition-opacity duration-150',
              sides.right ? 'opacity-100' : 'opacity-0')} />
          </div>
        ) : strip}
      </ScrollableContext.Provider>
    </LookContext.Provider>
  )
}

export function TabsTrigger({ icon: Icon, badge, className, children, ...rest }: RadixTabs.TabsTriggerProps & {
  icon?: ComponentType<{ className?: string }>
  /** Shown after the label — e.g. a dot for unsaved changes. Give it its own aria text. */
  badge?: ReactNode
}) {
  const look = useContext(LookContext)
  const scrollable = useContext(ScrollableContext)
  return (
    <RadixTabs.Trigger
      className={cn(
        'inline-flex items-center justify-center gap-1.5 text-sm font-medium transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        look === 'segmented'
          ? cn('flex-1 h-8 px-3 rounded-lg text-ink-muted hover:text-ink',
            'data-[state=active]:bg-canvas-elevated data-[state=active]:text-ink data-[state=active]:shadow-sm')
          : cn('h-9 -mb-px border-b-2 border-transparent text-ink-muted hover:text-ink',
            'data-[state=active]:border-accent-lineage data-[state=active]:text-ink'),
        // In a strip that scrolls, a tab keeps its size: it is the strip that moves.
        scrollable && 'shrink-0 whitespace-nowrap',
        className,
      )}
      {...rest}
    >
      {Icon && <Icon className="w-4 h-4 shrink-0" aria-hidden />}
      {children}
      {badge}
    </RadixTabs.Trigger>
  )
}

export function TabsContent({ className, ...rest }: RadixTabs.TabsContentProps) {
  return <RadixTabs.Content className={cn('focus-visible:outline-none', className)} {...rest} />
}
