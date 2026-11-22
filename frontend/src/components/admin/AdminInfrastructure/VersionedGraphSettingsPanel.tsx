/**
 * VersionedGraphSettingsPanel — what versioned graphs are set to, read-only: each category of
 * settings in the words the server writes from the values in force, and whether its switch is on
 * where it has one. Each category links to itself in Admin → Versioned graphs → Settings
 * (`#category-builds`), where every setting is changed; this page only reports them.
 */
import { Link } from 'react-router-dom'
import { ArrowRight, Loader2, SlidersHorizontal } from 'lucide-react'
import { FEATURE_NAMES } from '@/components/settings/format'
import { categoryAnchor } from '@/components/admin/AdminVersionedGraphs/meta'
import { settingsError, useSettingsSchema } from '@/services/settingsService'
import { useFeature } from '@/store/features'

const SETTINGS = '/admin/versioned-graphs?tab=settings'

function SwitchState({ featureKey }: { featureKey: string }) {
    const on = useFeature(featureKey)
    return <p className="mt-0.5 text-[11px] font-medium text-ink-secondary">{FEATURE_NAMES[featureKey] ?? featureKey}: {on ? 'on' : 'off'}</p>
}

export function VersionedGraphSettingsPanel() {
    const schemaQ = useSettingsSchema()
    const categories = [...(schemaQ.data?.categories ?? [])].sort((a, b) => a.order - b.order)

    return (
        <section aria-labelledby="versioned-graph-settings-title" className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden">
            <div className="px-5 pt-4 pb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="flex items-center gap-2 min-w-0">
                    <SlidersHorizontal className="w-4 h-4 text-indigo-500 shrink-0" />
                    <div className="min-w-0">
                        <h2 id="versioned-graph-settings-title" className="text-sm font-semibold text-ink">Versioned graph settings</h2>
                        <p className="text-[11px] text-ink-muted">What each category is set to now. Settings are changed in Admin → Versioned graphs.</p>
                    </div>
                </div>
                <Link to={SETTINGS} className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline">
                    Open the settings <ArrowRight aria-hidden className="w-3 h-3" />
                </Link>
            </div>

            {schemaQ.isPending ? (
                <p className="px-5 pb-4 text-xs text-ink-muted flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the settings…</p>
            ) : schemaQ.error ? (
                <p className="px-5 pb-4 text-xs text-red-600 dark:text-red-400">Couldn’t read the settings: {settingsError(schemaQ.error).message}</p>
            ) : (
                <ul className="px-5 pb-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
                    {categories.map((c) => (
                        <li key={c.id} className="min-w-0">
                            <Link to={`${SETTINGS}#${categoryAnchor(c.id)}`} className="inline-flex items-center gap-1 text-xs font-semibold text-ink hover:underline">
                                {c.label} <ArrowRight aria-hidden className="w-3 h-3 text-ink-muted" />
                            </Link>
                            {c.masterSwitch && <SwitchState featureKey={c.masterSwitch} />}
                            <p className="mt-0.5 text-[11px] leading-snug text-ink-secondary">{c.posture}</p>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}
