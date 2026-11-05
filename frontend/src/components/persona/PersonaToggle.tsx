import { motion } from 'framer-motion'
import { Briefcase, Code2 } from 'lucide-react'
import { usePersonaStore } from '@/store/persona'
import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'
import { formatShortcut } from '@/lib/platform'

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
  const { mode, toggleMode } = usePersonaStore()
  const business = mode === 'business'

  return (
    <HoverTip
      className="inline-flex"
      label={business ? 'Business view: the essentials' : 'Technical view: every tool'}
      detail={business
        ? 'Fewer tools on screen, and names only. Switch to Technical for every tool, with each entity’s identifier under its name.'
        : 'Every tool on every row, and each entity’s identifier under its name: its data source’s identifier property (such as id), or its URN. Switch to Business for the essentials.'}
      shortcut={formatShortcut('mod+/')}
    >
      <button
        type="button"
        onClick={toggleMode}
        aria-label={business ? 'Business view. Switch to the Technical view' : 'Technical view. Switch to the Business view'}
        className={cn(
          "relative flex items-center gap-1 p-1 rounded-lg",
          "bg-black/5 dark:bg-white/5",
          "transition-colors duration-200"
        )}
      >
        {/* Sliding Background */}
        <motion.div
          className={cn(
            "absolute top-1 bottom-1 w-[calc(50%-2px)] rounded-md",
            business
              ? "bg-accent-business/20"
              : "bg-accent-technical/20"
          )}
          animate={{
            left: business ? 4 : 'calc(50% + 2px)',
          }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />

        {/* Business Option */}
        <div
          className={cn(
            "relative z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-md",
            "transition-colors duration-200",
            business
              ? "text-accent-business"
              : "text-ink-muted hover:text-ink-secondary"
          )}
        >
          <Briefcase className="w-4 h-4" />
          <span className="text-sm font-medium">Business</span>
        </div>

        {/* Technical Option */}
        <div
          className={cn(
            "relative z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-md",
            "transition-colors duration-200",
            !business
              ? "text-accent-technical"
              : "text-ink-muted hover:text-ink-secondary"
          )}
        >
          <Code2 className="w-4 h-4" />
          <span className="text-sm font-medium">Technical</span>
        </div>
      </button>
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
