import { motion } from 'framer-motion'
import { Sliders, Activity, Eye, Hash } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePreferencesStore } from '@/store/preferences'
import type { UseUnifiedTraceResult } from '@/hooks/useUnifiedTrace'
import { TraceDockControls, type GranularityOption } from './TraceDockControls'
import { TraceDockPerformance } from './TraceDockPerformance'

export interface TraceDockSettingsProps {
  trace: UseUnifiedTraceResult
  granularityOptions: GranularityOption[]
  availableEdgeTypes: string[]
  resolveEdgeColor: (edgeType: string) => string
  /** See `TraceDockControls` — withdraws the controls the native engine
   *  cannot honour. */
  nativeMode?: boolean
}

/**
 * Settings tab — premium expert mode. Two sections, each headed by a
 * gradient identity icon + eyebrow (matches the app's section-header
 * vocabulary): Tuning (controls) and Performance (telemetry).
 */
export function TraceDockSettings({
  trace,
  granularityOptions,
  availableEdgeTypes,
  resolveEdgeColor,
  nativeMode = false,
}: TraceDockSettingsProps) {
  return (
    <motion.div
      key="settings"
      id="trace-dock-panel-settings"
      role="tabpanel"
      aria-labelledby="trace-dock-tab-settings"
      initial={{ opacity: 0, scale: 0.99 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.99 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="flex-1 min-h-0 flex flex-col overflow-y-auto custom-scrollbar"
    >
      <div className="px-5 pt-4 pb-5 flex flex-col gap-5">
        <Section icon={<Sliders className="w-3.5 h-3.5" strokeWidth={2.2} />} label="Tuning">
          <TraceDockControls
            config={trace.config}
            granularityOptions={granularityOptions}
            availableEdgeTypes={availableEdgeTypes}
            resolveEdgeColor={resolveEdgeColor}
            onChangeConfig={trace.setConfig}
            onApply={() => { trace.retrace() }}
            nativeMode={nativeMode}
          />
        </Section>

        {nativeMode && (
          <Section icon={<Eye className="w-3.5 h-3.5" strokeWidth={2.2} />} label="Display">
            <LineageCountsToggle />
          </Section>
        )}

        <Section icon={<Activity className="w-3.5 h-3.5" strokeWidth={2.2} />} label="Performance">
          <TraceDockPerformance meta={trace.result?.meta} />
        </Section>
      </div>
    </motion.div>
  )
}

function Section({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            'shrink-0 w-7 h-7 rounded-lg flex items-center justify-center',
            'bg-accent-lineage border border-accent-lineage shadow-sm shadow-accent-lineage/20',
          )}
        >
          <span className="text-white" aria-hidden>{icon}</span>
        </div>
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold text-ink">
          {label}
        </span>
        <span className="flex-1 h-px bg-gradient-to-r from-accent-lineage/40 via-white/10 to-transparent" />
      </div>
      <div className="pl-0">{children}</div>
    </div>
  )
}

/** "N on this lineage" pills on the trace's cards — how much of what is
 *  inside a closed card the lineage runs through. On by default; persisted
 *  with the other canvas preferences. */
function LineageCountsToggle() {
  const show = usePreferencesStore((s) => s.showLineageCounts) ?? true
  const toggle = usePreferencesStore((s) => s.toggleLineageCounts)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={show}
      aria-label="Lineage counts on cards"
      onClick={toggle}
      className={cn(
        'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg border text-left transition-colors',
        show
          ? 'bg-accent-lineage/12 border-accent-lineage/35 shadow-sm shadow-accent-lineage/10'
          : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
      )}
    >
      <div
        className={cn(
          'flex-shrink-0 w-[32px] h-[18px] rounded-full relative transition-colors duration-200',
          show ? 'bg-accent-lineage/85' : 'bg-ink-muted/25 dark:bg-white/15',
        )}
      >
        <div
          className={cn(
            'absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200',
            show ? 'left-[15px]' : 'left-[2px]',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'text-[12px] font-medium leading-tight flex items-center gap-1.5',
            show ? 'text-accent-lineage' : 'text-ink',
          )}
        >
          <Hash className="w-3.5 h-3.5" strokeWidth={2.2} />
          <span>Lineage counts on cards</span>
        </div>
        <div className="text-[11px] text-ink-muted/80 leading-snug mt-0.5">
          Show “N on this lineage” beside each closed card
        </div>
      </div>
    </button>
  )
}
