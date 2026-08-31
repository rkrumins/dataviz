import { motion } from 'framer-motion'
import { Briefcase, Code2 } from 'lucide-react'
import { usePersonaStore } from '@/store/persona'
import { cn } from '@/lib/utils'

/**
 * PersonaToggle - Switch between Business and Technical views
 *
 * Business: the name a person recognises — a curated `businessLabel` override
 * when one exists, otherwise the entity's display name.
 * Technical: the same name, with the entity's technical identity revealed under
 * it — the qualified name, or the URN when the qualified name is only the
 * display name again. Applies to context-view rows, graph node cards and the
 * entity drawer. `lib/entityDisplayName.ts` owns the rule; the tooltips below
 * must keep naming what it actually does.
 */
export function PersonaToggle() {
  const { mode, toggleMode } = usePersonaStore()

  return (
    <button
      onClick={toggleMode}
      className={cn(
        "relative flex items-center gap-1 p-1 rounded-lg",
        "bg-black/5 dark:bg-white/5",
        "transition-colors duration-200"
      )}
      title={
        mode === 'business'
          ? 'Business view: names only. Switch to Technical to show each entity’s qualified name (or URN) under its name.'
          : 'Technical view: each entity’s qualified name (or URN) is shown under its name. Switch to Business for names only.'
      }
    >
      {/* Sliding Background */}
      <motion.div
        className={cn(
          "absolute top-1 bottom-1 w-[calc(50%-2px)] rounded-md",
          mode === 'business' 
            ? "bg-accent-business/20" 
            : "bg-accent-technical/20"
        )}
        animate={{
          left: mode === 'business' ? 4 : 'calc(50% + 2px)',
        }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />

      {/* Business Option */}
      <div
        title="Business — the name people use, and nothing else"
        className={cn(
          "relative z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-md",
          "transition-colors duration-200",
          mode === 'business'
            ? "text-accent-business"
            : "text-ink-muted hover:text-ink-secondary"
        )}
      >
        <Briefcase className="w-4 h-4" />
        <span className="text-sm font-medium">Business</span>
      </div>

      {/* Technical Option */}
      <div
        title="Technical — adds the qualified name (or the URN) under every name, on the canvas and in the entity drawer"
        className={cn(
          "relative z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-md",
          "transition-colors duration-200",
          mode === 'technical'
            ? "text-accent-technical"
            : "text-ink-muted hover:text-ink-secondary"
        )}
      >
        <Code2 className="w-4 h-4" />
        <span className="text-sm font-medium">Technical</span>
      </div>
    </button>
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

