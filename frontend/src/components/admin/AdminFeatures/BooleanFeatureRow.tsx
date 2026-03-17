import { HelpCircle, ExternalLink, Loader2 } from 'lucide-react'
import { ToggleSwitch } from './ToggleSwitch'
import type { FeatureDefinition } from '@/services/featuresService'

export function BooleanFeatureRow({
  feature,
  value,
  onChange,
  saving,
  previewLabel,
}: {
  feature: FeatureDefinition
  value: boolean
  onChange: (v: boolean) => void
  saving: boolean
  /** When set, show a "not yet wired" style badge for this feature. */
  previewLabel?: string
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0 border-b border-glass-border last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-ink">{feature.name}</span>
          {previewLabel && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/25"
              title="Setting is saved; full behaviour will roll out in a future update."
            >
              {previewLabel}
            </span>
          )}
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
        </div>
        <p className="text-sm text-ink-muted mt-1 leading-relaxed">{feature.description}</p>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {saving && <Loader2 className="w-4 h-4 animate-spin text-ink-muted" />}
        <ToggleSwitch
          checked={value}
          onChange={onChange}
          disabled={saving}
          aria-label={`Toggle ${feature.name}`}
        />
      </div>
    </div>
  )
}
