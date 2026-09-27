/**
 * Tabs — Radix Tabs with the app's look: a segmented strip (a drawer's View / Edit / JSON) or an
 * underline row. Keyboard, roving focus and ARIA come from Radix; a trigger can carry an icon and
 * a badge (an unsaved-changes dot, a count).
 */
import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import * as RadixTabs from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

type TabsLook = 'segmented' | 'underline'
const LookContext = createContext<TabsLook>('segmented')

export function Tabs(props: RadixTabs.TabsProps) {
  return <RadixTabs.Root {...props} />
}

export function TabsList({ look = 'segmented', className, children, ...rest }: RadixTabs.TabsListProps & { look?: TabsLook }) {
  return (
    <LookContext.Provider value={look}>
      <RadixTabs.List
        className={cn(
          look === 'segmented'
            ? 'flex items-center gap-1 p-1 rounded-xl bg-black/[0.05] dark:bg-white/[0.05]'
            : 'flex items-center gap-4 border-b border-glass-border',
          className,
        )}
        {...rest}
      >
        {children}
      </RadixTabs.List>
    </LookContext.Provider>
  )
}

export function TabsTrigger({ icon: Icon, badge, className, children, ...rest }: RadixTabs.TabsTriggerProps & {
  icon?: ComponentType<{ className?: string }>
  /** Shown after the label — e.g. a dot for unsaved changes. Give it its own aria text. */
  badge?: ReactNode
}) {
  const look = useContext(LookContext)
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
        className,
      )}
      {...rest}
    >
      {Icon && <Icon className="w-4 h-4" aria-hidden />}
      {children}
      {badge}
    </RadixTabs.Trigger>
  )
}

export function TabsContent({ className, ...rest }: RadixTabs.TabsContentProps) {
  return <RadixTabs.Content className={cn('focus-visible:outline-none', className)} {...rest} />
}
