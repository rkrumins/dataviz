/**
 * Sparkline — hand-rolled SVG polyline trend hint (no chart lib in this
 * app; precedent: SchemaHealthRing). De-emphasis stroke with the current
 * point in the accent, per the stat-tile trend spec.
 */

interface Props {
    points: number[]
    width?: number
    height?: number
    className?: string
}

export function Sparkline({ points, width = 96, height = 24, className }: Props) {
    if (points.length < 3) return null
    const min = Math.min(...points)
    const max = Math.max(...points)
    const span = max - min || 1
    const step = width / (points.length - 1)
    const pad = 2
    const y = (v: number) => pad + (height - 2 * pad) * (1 - (v - min) / span)
    const path = points.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
    const last = points[points.length - 1]

    return (
        <svg
            width={width} height={height} viewBox={`0 0 ${width} ${height}`}
            className={className} aria-hidden="true"
        >
            <polyline
                points={path}
                fill="none"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-indigo-300/60 dark:stroke-indigo-400/40"
            />
            <circle
                cx={width} cy={y(last)} r="2.5"
                className="fill-indigo-500 dark:fill-indigo-400"
            />
        </svg>
    )
}
