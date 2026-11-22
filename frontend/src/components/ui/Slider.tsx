/**
 * Slider — a value along a track, moved by dragging, by clicking the track, or by the keyboard
 * (arrows, Page Up / Page Down, Home / End).
 *
 * A role="slider" thumb with its value spoken in words (`format`: "85%", "While version 6 lands").
 * The track can carry marks (the recommended value, the default) so the choice has landmarks: their
 * labels sit above the track and its ends below it, so neither can land on the other.
 * The fill is the accent: a slider is how someone changes a value, and a change is accent-coloured
 * everywhere in the settings kit.
 */
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { sliderKeyValue, snap } from './sliderKeys'

export interface SliderMark {
    value: number
    label: string
}

export interface SliderProps {
    value: number
    onChange: (value: number) => void
    min: number
    max: number
    step?: number
    bigStep?: number
    /** The value in words, shown and spoken. */
    format?: (value: number) => string
    'aria-label'?: string
    'aria-labelledby'?: string
    'aria-describedby'?: string
    marks?: SliderMark[]
    /** Draws the fill from the start of the track (a level) or not at all (a position). */
    fill?: boolean
    disabled?: boolean
    /** Under the track, at the ends: "0%" and "100%" by default when `format` is given. */
    ends?: [ReactNode, ReactNode] | false
    className?: string
}

export function Slider({
    value, onChange, min, max, step = 1, bigStep, format, marks = [], fill = true, disabled = false, ends, className,
    'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, 'aria-describedby': ariaDescribedBy,
}: SliderProps) {
    const track = useRef<HTMLDivElement>(null)
    const thumb = useRef<HTMLDivElement>(null)
    const at = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / (max - min || 1)) * 100
    const words = format ?? ((v: number) => String(v))

    const fromPointer = (clientX: number) => {
        const r = track.current?.getBoundingClientRect()
        if (!r || r.width === 0) return value
        return snap(min + ((clientX - r.left) / r.width) * (max - min), min, max, step)
    }
    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        if (disabled || e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        thumb.current?.focus()
        onChange(fromPointer(e.clientX))
    }
    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        if (disabled || !e.currentTarget.hasPointerCapture?.(e.pointerId)) return
        onChange(fromPointer(e.clientX))
    }
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return
        const next = sliderKeyValue(e.key, value, { min, max, step, bigStep })
        if (next === null) return
        e.preventDefault()
        if (next !== value) onChange(next)
    }

    const pct = at(value)
    const showEnds = ends !== false && (ends || format)
    return (
        <div className={cn('select-none', disabled && 'opacity-55', className)}>
            {marks.length > 0 && (
                <div className="relative mb-0.5 h-4 text-[10px] text-ink-secondary" aria-hidden>
                    {marks.map((m) => {
                        const p = at(m.value)
                        return (
                            <span key={`${m.value}-${m.label}`} style={{ left: `${p}%` }}
                                className={cn('absolute whitespace-nowrap', p < 10 ? '' : p > 90 ? '-translate-x-full' : '-translate-x-1/2')}>
                                {m.label}
                            </span>
                        )
                    })}
                </div>
            )}
            <div
                ref={track}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                className={cn('relative h-6 touch-none', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}
            >
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-black/[0.08] dark:bg-white/[0.10]" />
                {fill && (
                    <div className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent-lineage" style={{ width: `${pct}%` }} />
                )}
                {marks.map((m) => (
                    <span key={`${m.value}-${m.label}`} aria-hidden title={m.label}
                        className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-muted/60"
                        style={{ left: `${at(m.value)}%` }} />
                ))}
                <div
                    ref={thumb}
                    role="slider"
                    tabIndex={disabled ? -1 : 0}
                    aria-label={ariaLabel}
                    aria-labelledby={ariaLabelledBy}
                    aria-describedby={ariaDescribedBy}
                    aria-valuemin={min}
                    aria-valuemax={max}
                    aria-valuenow={value}
                    aria-valuetext={words(value)}
                    aria-disabled={disabled || undefined}
                    onKeyDown={onKeyDown}
                    className={cn(
                        'absolute top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full',
                        'border-2 border-accent-lineage bg-canvas-elevated shadow-[0_1px_3px_rgba(15,23,42,0.25)]',
                        'outline-none focus-visible:ring-4 focus-visible:ring-accent-lineage/25',
                        'transition-shadow duration-150',
                    )}
                    style={{ left: `${pct}%` }}
                />
            </div>
            {showEnds && (
                <div className="relative mt-1 h-4 text-[10px] tabular-nums text-ink-secondary" aria-hidden>
                    <span className="absolute left-0">{ends ? ends[0] : words(min)}</span>
                    <span className="absolute right-0">{ends ? ends[1] : words(max)}</span>
                </div>
            )}
        </div>
    )
}
