import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { resolveCategoryStyle, prefersReducedMotion } from './constants'
import { BooleanFeatureRow } from './BooleanFeatureRow'
import { MultiSelectFeatureRow } from './MultiSelectFeatureRow'
import type { FeatureDefinition, FeatureCategory } from '@/services/featuresService'

/** Fallback when backend does not provide preview label/footer. */
const DEFAULT_PREVIEW_LABEL = 'Not yet wired'
const DEFAULT_PREVIEW_FOOTER = 'Your settings here are saved. Full behaviour for this section will be enabled in a future update.'

export function FeatureCard({
  categoryId,
  meta,
  features,
  values,
  onChange,
  savingKey,
  index,
}: {
  categoryId: string
  meta: FeatureCategory | undefined
  features: FeatureDefinition[]
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  savingKey: string | null
  index: number
}) {
  const { Icon, style, label } = resolveCategoryStyle(meta, categoryId)
  const reduced = prefersReducedMotion()
  const previewLabel = meta?.previewLabel ?? DEFAULT_PREVIEW_LABEL
  const previewFooter = meta?.previewFooter ?? DEFAULT_PREVIEW_FOOTER
  const categoryPreview = meta?.preview !== false
  const anyNotImplemented = features.some((f) => f.implemented !== true)
  const showCardFooter = categoryPreview && anyNotImplemented && previewFooter
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: reduced ? 0 : index * 0.05 }}
      className={cn(
        'relative overflow-hidden border border-glass-border rounded-xl p-6 bg-canvas-elevated',
        'hover:shadow-lg hover:border-indigo-500/10 dark:hover:border-indigo-500/20 transition-all duration-200'
      )}
    >
      <div className={cn('absolute inset-0 bg-gradient-to-br pointer-events-none', style.gradient)} />
      <div className="relative">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <div
            className={cn(
              'w-9 h-9 rounded-lg border flex items-center justify-center shrink-0',
              style.iconBg
            )}
          >
            <Icon className="w-4.5 h-4.5" />
          </div>
          <h2 className="text-lg font-semibold text-ink">{label}</h2>
        </div>
        <div className="space-y-0">
          {features.map((feature) => {
            const showFeaturePreview = feature.implemented !== true
            if (feature.type === 'boolean') {
              const val = values[feature.key] as boolean | undefined
              const value = val ?? (feature.default as boolean)
              return (
                <BooleanFeatureRow
                  key={feature.key}
                  feature={feature}
                  value={value}
                  onChange={(v) => onChange(feature.key, v)}
                  saving={savingKey === feature.key}
                  previewLabel={showFeaturePreview ? previewLabel : undefined}
                />
              )
            }
            if (feature.type === 'string[]') {
              const val = values[feature.key] as string[] | undefined
              const value = val ?? (feature.default as string[])
              return (
                <MultiSelectFeatureRow
                  key={feature.key}
                  feature={feature}
                  value={Array.isArray(value) ? value : []}
                  onChange={(v) => onChange(feature.key, v)}
                  saving={savingKey === feature.key}
                  previewLabel={showFeaturePreview ? previewLabel : undefined}
                />
              )
            }
            return null
          })}
        </div>
        {showCardFooter && (
          <p className="mt-4 pt-3 border-t border-glass-border text-[11px] text-ink-muted leading-relaxed">
            {previewFooter}
          </p>
        )}
      </div>
    </motion.div>
  )
}
