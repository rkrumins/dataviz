/**
 * StackedShareBar — part-to-whole as one horizontal bar plus a keyed list.
 *
 * Horizontal because these categories have long names (`local_signup`,
 * `admin_created`) that a column chart would have to rotate or truncate.
 *
 * Not a pie: at a glance a pie is fine for gross shares, but the moment two
 * slices are close a reader cannot rank them. The bar carries the shape, the
 * list underneath carries the numbers, and both are legible.
 *
 * Segments are separated by a 2px gap in the SURFACE colour — never a stroke.
 * A label only renders inside a segment when it actually fits; otherwise it
 * lives in the list below, which is where the value was always reachable.
 */
import { cn } from '@/lib/utils'
import { exact, percent } from '@/lib/formatMetric'
import { MARK, useChartTheme } from './chartTheme'

export interface ShareSlice {
    key: string
    count: number
}

/** The backend folds a long tail into this key. */
const OTHER_KEY = 'Other'

/**
 * Assign a colour to every slice.
 *
 * "Other" is the residual, not a category, so it takes the de-emphasis neutral
 * rather than a categorical slot. That is both more honest — a grey tail reads
 * as "everything else" — and load-bearing: the backend keeps the top six
 * classes plus "Other", which is seven, and the palette has six slots. Handing
 * "Other" a slot would wrap it back onto slot 1, so the residual would render
 * in the SAME colour as the largest category. Colour must never repeat inside
 * one chart, and a generated seventh hue is not the answer either — under
 * colour-vision deficiency it is indistinguishable from one already present.
 */
function assignColours(
    slices: ShareSlice[], series: readonly string[], neutral: string,
): string[] {
    let slot = 0
    return slices.map((s) =>
        s.key === OTHER_KEY ? neutral : series[slot++ % series.length])
}

interface Props {
    slices: ShareSlice[]
    /** Prettify raw enum keys (`local_signup` → `Local signup`). */
    labelOf?: (key: string) => string
    className?: string
}

export function StackedShareBar({ slices, labelOf, className }: Props) {
    const theme = useChartTheme()
    const total = slices.reduce((sum, s) => sum + s.count, 0)
    const label = labelOf ?? humanise
    const colours = assignColours(slices, theme.series, theme.neutralMark)

    if (total === 0) {
        return (
            <div className={cn('h-3 rounded-full bg-black/[0.05] dark:bg-white/[0.06]', className)} />
        )
    }

    return (
        <div className={className}>
            <div
                className="flex h-3 w-full overflow-hidden rounded-full"
                role="img"
                aria-label={slices.map((s) => `${label(s.key)} ${percent(s.count / total)}`).join(', ')}
            >
                {slices.map((s, i) => {
                    const share = s.count / total
                    if (share <= 0) return null
                    return (
                        <div
                            key={s.key}
                            title={`${label(s.key)}: ${exact(s.count)} (${percent(share, 1)})`}
                            style={{
                                width: `${share * 100}%`,
                                backgroundColor: colours[i],
                                // The gap is the surface showing through, not a border.
                                marginLeft: i === 0 ? 0 : MARK.surfaceGap,
                            }}
                        />
                    )
                })}
            </div>

            <ul className="mt-3 space-y-1.5">
                {slices.map((s, i) => (
                    <li key={s.key} className="flex items-center gap-2">
                        <span
                            aria-hidden
                            className="w-2.5 h-2.5 rounded-[3px] shrink-0"
                            style={{ backgroundColor: colours[i] }}
                        />
                        <span className="text-xs text-ink-secondary truncate flex-1 min-w-0">
                            {label(s.key)}
                        </span>
                        <span className="text-xs font-semibold text-ink tabular-nums">
                            {exact(s.count)}
                        </span>
                        <span className="text-[11px] text-ink-muted tabular-nums w-10 text-right">
                            {percent(s.count / total)}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    )
}

export function humanise(key: string): string {
    const spaced = key.replace(/[_-]/g, ' ').trim()
    return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
