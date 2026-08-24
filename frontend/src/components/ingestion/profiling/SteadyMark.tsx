/**
 * The mark for a series that did not move.
 *
 * It is drawn exactly as `Sparkline` draws a flat series — a hairline at the
 * level, a filled dot at the latest observation — so the Trend column reads as
 * one continuous track: the movers carry shape, the steady rows carry a level,
 * and nothing in the column changes vocabulary between rows.
 *
 * This is why it is not simply omitted. A column with gaps in it reads as
 * missing data; a level with a point on it reads as "observed, unchanged",
 * which is what actually happened. The unsaturated stroke is the whole
 * difference: a real series is the only thing in the column drawn in colour.
 */
import { cn } from '@/lib/utils'

interface Props {
    /** `first` when a source has only ever been observed once — a trend has
     *  not failed to appear, it has not started yet. */
    variant?: 'steady' | 'first'
    /** Reported in the accessible label, so the mark states its evidence. */
    observations?: number
    width?: number
    height?: number
    className?: string
}

export function SteadyMark({
    variant = 'steady', observations = 0, width = 120, height = 24, className,
}: Props) {
    const mid = height / 2
    const end = width - 4

    const label = variant === 'first'
        ? 'First observation — nothing to compare against yet'
        : observations > 1
            ? `Steady — unchanged across this window, over ${observations.toLocaleString()} observations`
            : 'Steady — unchanged across this window'

    return (
        <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={label}
            className={cn('overflow-visible', className)}
        >
            <title>{label}</title>
            {/* The level. Drawn short of the dot so the two do not merge into
                a lollipop at small sizes. */}
            {variant === 'steady' && (
                <line
                    x1={1} x2={end - 4} y1={mid} y2={mid}
                    strokeWidth={1.5} strokeLinecap="round"
                    className="stroke-slate-300 dark:stroke-slate-600"
                />
            )}
            {/* The latest observation, where a line would have ended, so the
                column still reads left-to-right in time. */}
            <circle
                cx={end} cy={mid} r={3.5}
                className="fill-slate-500 dark:fill-slate-400"
            />
        </svg>
    )
}
