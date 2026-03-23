import * as LucideIcons from 'lucide-react'

export function EmptyState({ icon, message, hint }: { icon: string; message: string; hint?: string }) {
  const Icon = (LucideIcons as Record<string, unknown>)[icon] as React.ComponentType<{ className?: string }> | undefined
  return (
    <div className="text-center py-20 text-ink-muted">
      {Icon && (
        <div className="relative mx-auto mb-5 w-16 h-16 flex items-center justify-center">
          <div className="absolute inset-0 rounded-full bg-gradient-to-br from-indigo-500/10 to-purple-500/10 dark:from-indigo-500/15 dark:to-purple-500/15" />
          <Icon className="w-8 h-8 relative z-10 text-indigo-400 dark:text-indigo-500 opacity-60" />
        </div>
      )}
      <p className="text-sm font-semibold text-ink-secondary">{message}</p>
      {hint && <p className="text-xs mt-2 max-w-xs mx-auto text-ink-muted leading-relaxed">{hint}</p>}
    </div>
  )
}
