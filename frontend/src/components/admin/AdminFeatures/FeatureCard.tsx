import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { resolveCategoryStyle, prefersReducedMotion } from './constants'
import { FeatureRow } from './FeatureRow'
import type { FeatureDefinition, FeatureCategory } from '@/services/featuresService'

/** Fallback when the backend does not provide preview label/footer. */
const DEFAULT_PREVIEW_FOOTER =
  'Your settings here are saved. Full behaviour for this section will be enabled in a future update.'

/**
 * One category of features.
 *
 * The "not yet wired" chrome is still here, but it is now driven by what the CODE says
 * (`implemented`, derived from the gates that actually exist) rather than by a checkbox an admin
 * could tick. It renders for a category that genuinely holds an unwired flag — which, today, none
 * do. If one appears, this says so honestly instead of presenting a decorative switch as real.
 */
export function FeatureCard({
  categoryId,
  meta,
  features,
  allFeatures,
  values,
  onChange,
  savingKey,
  index,
}: {
  categoryId: string
  meta: FeatureCategory | undefined
  features: FeatureDefinition[]
  /** The WHOLE registry — a dependency may live in another category, and resolving it
   *  against this category's slice alone would silently report "no dependency". */
  allFeatures: FeatureDefinition[]
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  savingKey: string | null
  index: number
}) {
  const { Icon, style, label } = resolveCategoryStyle(meta, categoryId)
  const reduced = prefersReducedMotion()
  const previewFooter = meta?.previewFooter ?? DEFAULT_PREVIEW_FOOTER
  const unwired = features.filter(f => f.implemented !== true)
  const showCardFooter = meta?.preview !== false && unwired.length > 0 && previewFooter

  /** A flag whose dependency is off cannot do anything, and the row should admit it.
   *
   *  Resolve through the definition's default, not the raw value: a flag the admin has never
   *  touched has no stored value at all, so reading `values[key]` alone would miss a dependency
   *  that ships OFF — and the row would quietly claim to be in force while doing nothing. */
  const offDependencies = (feature: FeatureDefinition): string[] =>
    (feature.dependsOn ?? [])
      .filter(depKey => {
        const dep = allFeatures.find(f => f.key === depKey)
        if (!dep) return false
        return (values[depKey] ?? dep.default) === false
      })
      .map(depKey => allFeatures.find(f => f.key === depKey)?.name ?? depKey)

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: reduced ? 0 : index * 0.05 }}
      className={cn(
        'relative overflow-hidden border border-glass-border rounded-2xl p-6 bg-canvas-elevated',
        'hover:shadow-lg hover:border-indigo-500/10 dark:hover:border-indigo-500/20 transition-all duration-200'
      )}
    >
      <div className={cn('absolute inset-0 bg-gradient-to-br pointer-events-none', style.gradient)} />
      <div className="relative">
        <div className="flex items-center gap-3 mb-5 flex-wrap">
          <div
            className={cn(
              'w-9 h-9 rounded-lg border flex items-center justify-center shrink-0',
              style.iconBg
            )}
          >
            {/* w-4.5 is not a Tailwind class — it silently rendered at the icon's intrinsic size. */}
            <Icon className="w-4 h-4" />
          </div>
          <h2 className="text-lg font-semibold text-ink">{label}</h2>
        </div>

        <div>
          {features.map(feature => {
            const stored = values[feature.key]
            const value = stored ?? feature.default
            return (
              <FeatureRow
                key={feature.key}
                feature={feature}
                value={value}
                onChange={v => onChange(feature.key, v)}
                saving={savingKey === feature.key}
                inertBecauseOf={offDependencies(feature)}
              />
            )
          })}
        </div>

        {showCardFooter && (
          <p className="mt-5 pt-3 border-t border-glass-border text-[11px] text-ink-muted leading-relaxed">
            {previewFooter}
          </p>
        )}
      </div>
    </motion.div>
  )
}
