/**
 * PropertyShapeField — "how does this graph store its properties?", asked at
 * onboarding time.
 *
 * Sits beside NodeIdentityField because it answers the third part of the same
 * question: identity says which property names a node, display name says which
 * one labels it, and this says where the rest of them live. Two thirds of that
 * decision already lives in the wizards; this is the missing third.
 *
 * Opens itself only when the graph probe actually finds nesting — an advanced
 * control that unfolds when it matters and stays out of the way when it
 * doesn't.
 */
import { useEffect, useState } from 'react'
import { ChevronDown, FolderTree, Loader2, PackageOpen, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import { HelpHint } from '@/components/ui/InfoTooltip'
import { PropertyMappingForm } from './PropertyMappingForm'
import { useDetectedContainers } from './useDetectedContainers'
import {
    DEFAULT_PROPERTY_MAPPING,
    isCustomisedMapping,
    type PropertyMapping,
} from '@/services/propertyStorageService'

export function PropertyShapeField({
    value, onChange, providerId, graphName, disabled,
}: {
    value: PropertyMapping
    onChange: (next: PropertyMapping) => void
    providerId: string | undefined
    /** Physical graph/asset name — the probe is per graph, not per provider. */
    graphName: string | undefined
    disabled?: boolean
}) {
    const { containerKeys, nestedLabels, loading } = useDetectedContainers(
        providerId, graphName, true,
    )
    const [open, setOpen] = useState(false)
    const [autoOpened, setAutoOpened] = useState(false)

    const nested = containerKeys.length > 0

    // Unfold once, when the probe comes back with something to fix. Guarded so
    // a user who closes it again doesn't have it spring back open on re-render.
    useEffect(() => {
        if (nested && !autoOpened) {
            setAutoOpened(true)
            setOpen(true)
        }
    }, [nested, autoOpened])

    // Seed the container key from what the graph actually uses, so the default
    // isn't a guess the user has to correct.
    useEffect(() => {
        if (!nested) return
        if (isCustomisedMapping(value)) return
        if (containerKeys.includes(value.containerKey ?? '')) return
        onChange({ ...value, containerKey: containerKeys[0] })
        // Runs once per detection result; `value` is intentionally not a dep —
        // re-seeding on every keystroke would fight the user.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nested, containerKeys])

    const customised = isCustomisedMapping(value)

    return (
        <div className={cn(
            'rounded-xl border overflow-hidden transition-colors',
            nested
                ? 'border-indigo-500/30 bg-indigo-500/[0.04]'
                : 'border-glass-border bg-black/[0.02] dark:bg-white/[0.02]',
        )}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left"
            >
                <PackageOpen className={cn(
                    'w-3.5 h-3.5 flex-shrink-0',
                    nested ? 'text-indigo-500' : 'text-ink-muted',
                )} />
                <span className="text-xs font-semibold text-ink">Property shape</span>
                <HelpHint
                    label="property shape"
                    content={
                        <>
                            <span className="font-semibold">Where this graph keeps its properties.</span>
                            {' '}Graphs built outside the platform usually put every property
                            inside one dictionary — <code className="font-mono">n.properties</code> —
                            instead of giving each its own field. They still display, but
                            Advanced Search can't filter on them, because only a real field
                            can be indexed.
                        </>
                    }
                />

                <span className="ml-auto flex items-center gap-2">
                    {loading ? (
                        <span className="flex items-center gap-1.5 text-[10.5px] text-ink-muted">
                            <Loader2 className="w-3 h-3 animate-spin" /> Checking the graph…
                        </span>
                    ) : nested ? (
                        <span className="text-[10.5px] font-semibold text-indigo-600 dark:text-indigo-400">
                            Nested under <code className="font-mono">{containerKeys[0]}</code>
                        </span>
                    ) : (
                        <span className="text-[10.5px] text-ink-muted">
                            {customised ? 'Customised' : 'Already flat'}
                        </span>
                    )}
                    <ChevronDown className={cn(
                        'w-3.5 h-3.5 text-ink-muted transition-transform',
                        open && 'rotate-180',
                    )} />
                </span>
            </button>

            {open && (
                <div className="px-3.5 pb-3.5 space-y-3 border-t border-glass-border/50 pt-3">
                    {nested ? (
                        <div className="flex items-start gap-2 text-[11px] text-ink-secondary leading-relaxed">
                            <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-indigo-500" />
                            <span>
                                {nestedLabels.length === 1
                                    ? <><span className="font-semibold text-ink">{nestedLabels[0]}</span> keeps</>
                                    : <><span className="font-semibold text-ink">{nestedLabels.length} types</span> keep</>}
                                {' '}properties inside{' '}
                                <code className="font-mono text-ink">{containerKeys[0]}</code>.
                                Unpacking gives each one its own field, so{' '}
                                <code className="font-mono text-ink">
                                    {containerKeys[0]}{value.separator}format
                                </code>{' '}
                                becomes searchable and shows up as a{' '}
                                <FolderTree className="inline w-3 h-3 -mt-0.5" /> folder in the
                                properties panel.
                            </span>
                        </div>
                    ) : (
                        <p className="text-[11px] text-ink-muted leading-relaxed">
                            Nothing nested turned up in the graph probe — each property already
                            looks like its own field. Set a container key here only if you know
                            this source nests them and the probe's sample missed it.
                        </p>
                    )}

                    <PropertyMappingForm
                        value={value}
                        onChange={onChange}
                        disabled={disabled}
                        detectedContainerKeys={containerKeys}
                    />

                    {customised && (
                        <button
                            type="button"
                            onClick={() => onChange(DEFAULT_PROPERTY_MAPPING)}
                            className="text-[11px] font-semibold text-ink-muted hover:text-ink transition-colors"
                        >
                            Reset to defaults
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
