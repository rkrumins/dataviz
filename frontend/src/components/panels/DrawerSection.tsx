/**
 * Section — one titled block of the entity drawer.
 *
 * Extracted from EntityDrawer so the primitive every section is built from
 * can be read and tested on its own, and so collapsibility lives in one
 * place rather than being re-implemented per section.
 *
 * A collapsible section's header IS the control: the whole title row is
 * the hit target, `action` stays outside it (an action is not a toggle),
 * and the choice is remembered per `sectionKey` in the preferences store —
 * a deep entity should not have to be re-folded on every visit. Absent
 * from that map means OPEN, so a section never arrives hidden and a stored
 * map from before a section existed can never hide it.
 */
import type React from 'react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'
import { usePreferencesStore } from '@/store/preferences'

export interface SectionProps {
  title: string
  icon?: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  action?: React.ReactNode
  /** Let content extend closer to the drawer edges (title stays aligned).
   *  Used for the content-dense Properties section. */
  flush?: boolean
  /** Turn the title row into a disclosure. Needs `sectionKey` to remember. */
  collapsible?: boolean
  /** Stable id for the remembered open/closed choice. */
  sectionKey?: string
}

export function Section({
  title,
  icon: Icon,
  children,
  action,
  flush,
  collapsible,
  sectionKey,
}: SectionProps) {
  const collapsed = usePreferencesStore(
    (s) => (collapsible && sectionKey ? !!s.drawerSectionsCollapsed[sectionKey] : false),
  )
  const toggleSection = usePreferencesStore((s) => s.toggleDrawerSection)

  const heading = (
    <>
      {Icon && <Icon className="w-4 h-4 text-ink-muted" />}
      <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
        {title}
      </h3>
    </>
  )

  return (
    <div className="px-5 py-4">
      <div
        className={cn(
          'flex items-center justify-between gap-2',
          // No trailing gap under a folded section — the next section's own
          // padding is the whole separation.
          collapsed ? 'mb-0' : 'mb-3',
        )}
      >
        {collapsible && sectionKey ? (
          <button
            type="button"
            onClick={() => toggleSection(sectionKey)}
            aria-expanded={!collapsed}
            className={cn(
              'group flex items-center gap-2 min-w-0 -m-1 p-1 rounded-lg',
              'hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
            )}
          >
            <ChevronDown
              className={cn(
                'w-3.5 h-3.5 text-ink-muted/70 shrink-0 transition-transform duration-200',
                !collapsed && 'rotate-180',
              )}
              strokeWidth={2.2}
            />
            {heading}
          </button>
        ) : (
          <div className="flex items-center gap-2">{heading}</div>
        )}
        {action}
      </div>
      {!collapsed && (flush ? <div className="-mx-3">{children}</div> : children)}
    </div>
  )
}
