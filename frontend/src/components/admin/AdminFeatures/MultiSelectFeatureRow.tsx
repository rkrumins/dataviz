import { HelpCircle, ExternalLink, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FeatureDefinition } from '@/services/featuresService'

export function MultiSelectFeatureRow({
  feature,
  value,
  onChange,
  saving,
}: {
  feature: FeatureDefinition
  value: string[]
  onChange: (v: string[]) => void
  saving: boolean
}) {
  const options = feature.options ?? []
  const handleToggle = (id: string, checked: boolean) => {
    if (checked) {
      onChange([...value, id])
    } else {
      if (value.length <= 1) return
      onChange(value.filter((x) => x !== id))
    }
  }

  return (
    <div className="py-4 first:pt-0 last:pb-0 border-b border-glass-border last:border-b-0">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-sm font-semibold text-ink">{feature.name}</span>
        {feature.adminHint && (
          <span
            title={feature.adminHint}
            className="text-ink-muted hover:text-ink-secondary transition-colors cursor-help"
            aria-label={feature.adminHint}
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </span>
        )}
        {feature.helpUrl && (
          <a
            href={feature.helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
            aria-label={`Learn more about ${feature.name}`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>Docs</span>
          </a>
        )}
        {saving && <Loader2 className="w-4 h-4 animate-spin text-ink-muted" />}
      </div>
      <p className="text-sm text-ink-muted mb-3">{feature.description}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const checked = value.includes(opt.id)
          const isLastChecked = checked && value.length === 1
          return (
            <label
              key={opt.id}
              className={cn(
                'inline-flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all duration-150',
                'hover:scale-[1.02] active:scale-[0.98]',
                checked
                  ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-600 dark:text-indigo-400 shadow-sm'
                  : 'bg-canvas-elevated border-glass-border text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:border-indigo-500/20',
                saving && 'pointer-events-none opacity-70 hover:scale-100 active:scale-100'
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => handleToggle(opt.id, e.target.checked)}
                disabled={saving || (isLastChecked && checked)}
                className="sr-only"
                aria-label={`${opt.label} view mode`}
              />
              {checked ? (
                <Check className="w-4 h-4 text-indigo-500 shrink-0" strokeWidth={2.5} />
              ) : (
                <span className="w-4 h-4 rounded border border-glass-border shrink-0 bg-canvas-elevated" />
              )}
              <span className="text-sm font-medium">{opt.label}</span>
            </label>
          )
        })}
      </div>
      {value.length === 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">Select at least one view mode.</p>
      )}
    </div>
  )
}
