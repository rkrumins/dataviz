/**
 * ViewLayerStrip — a catalogue card showing THIS view's layers, not a picture
 * of its category.
 *
 * The card's preview slot used to hold `MiniPreview`, a stock SVG keyed only on
 * `viewType`. Every Context View in the Explorer therefore drew the identical
 * rose block — sixty-five cards, one picture, repeating a fact the "CONTEXT
 * VIEW" label directly above it already stated. A third of each card was spent
 * saying nothing that distinguished one view from the next, on the one screen
 * whose whole job is telling them apart.
 *
 * The layers were already in hand: `config.layout.referenceLayout.layers`
 * arrives with the view the card is built from, so this costs no request and no
 * extra field. It is the same data the preview drawer prints as "Reference
 * model layers (7)" — the card now shows a miniature of it, and the two
 * surfaces finally agree about what a view IS.
 *
 * BUILT FOR A GRID, which rules out how the drawer draws the same thing.
 * `ReferenceLayerPreview` carries per-instance state, an effect, a scroll
 * listener and a ResizeObserver — correct for one panel, sixty-five times the
 * wrong thing here. This is a pure function of its props: no state, no effects,
 * no observers, no measurement. It renders a fixed number of columns and counts
 * the rest, so nothing reflows, nothing observes, and a card re-render costs a
 * handful of divs. Memoised so the common re-render (hover, selection, a usage
 * figure landing) does not touch it at all.
 *
 * COLOUR COMES FROM THE LAYER, so it must be inline. `layer.color` is authored
 * per view and arrives as a hex string at runtime; Tailwind's JIT only sees
 * source text, so no class can carry it. Inline `style` also steps around the
 * repo's dead-alpha trap entirely — `#f43f5e14` is a real eight-digit hex the
 * browser resolves, not a `/8` modifier on a bare `var()` token that would
 * compile to nothing. `ReferenceLayerPreview` reached the same conclusion.
 */
import { memo, useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { ViewLayerConfig } from '@/types/schema'

/**
 * How many layers get a column before the rest become a count.
 *
 * Fixed, NOT measured. A card is ~250px wide, so four columns leave ~56px each
 * — enough for a short name to read and a long one to truncate honestly. Fitting
 * more by measuring would need a ResizeObserver per card, which is exactly the
 * cost this component exists to avoid; a view with nine layers is better served
 * by "+5" than by nine illegible slivers.
 */
const MAX_COLUMNS = 4

/** The rose the stock illustration used, for a layer authored without a colour. */
const FALLBACK_COLOUR = '#f43f5e'

/**
 * Entity-type ticks under a layer's name — the miniature of the cards that
 * layer's column holds on the canvas. Capped at three: past that the ticks stop
 * being countable at this size and become texture, and texture is what the
 * stock illustration already was.
 */
const MAX_TICKS = 3

export interface ViewLayerStripProps {
    layers: ViewLayerConfig[]
    className?: string
}

function ViewLayerStripImpl({ layers, className }: ViewLayerStripProps) {
    // Sorted once per layers identity. Trivial for a handful of entries, but a
    // card re-renders on hover and selection and this need not participate.
    const { shown, overflow } = useMemo(() => {
        const sorted = [...layers].sort(
            (a, b) => (a.order ?? a.sequence ?? 0) - (b.order ?? b.sequence ?? 0),
        )
        return {
            shown: sorted.slice(0, MAX_COLUMNS),
            overflow: Math.max(0, sorted.length - MAX_COLUMNS),
        }
    }, [layers])

    if (shown.length === 0) return null

    return (
        <div
            className={cn('flex items-stretch gap-1 h-full', className)}
            // One label for the whole strip. Per-column text would have a
            // screen reader announce four disconnected words inside a card
            // whose name it has already read.
            role="img"
            aria-label={
                `${layers.length} layer${layers.length === 1 ? '' : 's'}: ` +
                shown.map(l => l.name).join(', ') +
                (overflow > 0 ? ` and ${overflow} more` : '')
            }
        >
            {shown.map(layer => {
                const colour = layer.color ?? FALLBACK_COLOUR
                const ticks = Math.min(layer.entityTypes?.length ?? 0, MAX_TICKS)
                return (
                    <div
                        key={layer.id}
                        className="flex-1 min-w-0 rounded-md border overflow-hidden flex flex-col"
                        style={{ borderColor: `${colour}33`, backgroundColor: `${colour}0d` }}
                    >
                        {/* The accent edge. Reading the layer's colour at full
                            strength on a 2px rule, rather than as a wash behind
                            text, is what keeps the name legible in both themes. */}
                        <div className="h-[2px] shrink-0" style={{ backgroundColor: colour }} />
                        <div className="px-1.5 pt-1 min-w-0">
                            <span
                                className="block text-[9px] font-semibold leading-tight truncate"
                                style={{ color: colour }}
                            >
                                {layer.name}
                            </span>
                        </div>
                        {/* The entity types this layer holds, as the cards they
                            become on the canvas. A layer scoped to nothing draws
                            none — an empty layer should look empty. */}
                        {ticks > 0 && (
                            <div className="px-1.5 pb-1 pt-1 flex flex-wrap gap-[2px] content-start">
                                {Array.from({ length: ticks }, (_, i) => (
                                    <span
                                        key={i}
                                        className="h-[3px] w-3 rounded-[1px]"
                                        style={{ backgroundColor: `${colour}59` }}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                )
            })}

            {overflow > 0 && (
                <div className="shrink-0 w-7 rounded-md border border-glass-border flex items-center justify-center">
                    <span className="text-[9px] font-semibold text-ink-muted leading-none">
                        +{overflow}
                    </span>
                </div>
            )}
        </div>
    )
}

/**
 * The layers array is rebuilt whenever the parent rebuilds the view object, so
 * a default shallow compare would re-render on every list refresh. Comparing
 * the layers that actually reach the DOM keeps the strip inert through the
 * re-renders that do not change it.
 */
export const ViewLayerStrip = memo(ViewLayerStripImpl, (prev, next) => {
    if (prev.className !== next.className) return false
    if (prev.layers === next.layers) return true
    if (prev.layers.length !== next.layers.length) return false
    return prev.layers.every((l, i) => {
        const r = next.layers[i]
        return (
            l.id === r.id &&
            l.name === r.name &&
            l.color === r.color &&
            l.order === r.order &&
            l.sequence === r.sequence &&
            (l.entityTypes?.length ?? 0) === (r.entityTypes?.length ?? 0)
        )
    })
})
