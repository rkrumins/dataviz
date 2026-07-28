/**
 * Shared step chrome, matching the ViewWizard idiom.
 *
 * Each step is a centred column with a hero intro — a pill that names the
 * stage, a 2xl heading that asks the actual question, and one line of
 * subtitle. Blocks below it enter individually rather than as one slab, so
 * a step reads top-to-bottom instead of arriving all at once.
 *
 * Inputs are `border-2` with a focus ring, sized to be typed into rather
 * than filled in: this is a dialog someone opens a handful of times, not a
 * dense admin table.
 */
import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

/** Centred column. `wide` for the steps that carry a two-up card grid. */
export function StepColumn({
    children, wide,
}: {
    children: ReactNode
    wide?: boolean
}) {
    return (
        <div className={cn('mx-auto space-y-7', wide ? 'max-w-2xl' : 'max-w-xl')}>
            {children}
        </div>
    )
}

/** Pill · question · one line of why. */
export function StepHero({
    pill, pillIcon: PillIcon, title, subtitle, tone = 'indigo',
}: {
    pill: string
    pillIcon: LucideIcon
    title: string
    subtitle: string
    tone?: 'indigo' | 'emerald' | 'amber'
}) {
    const pillTone = {
        indigo: 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400',
        emerald: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400',
        amber: 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400',
    }[tone]

    return (
        <StepBlock className="text-center">
            <div className={cn(
                'inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium mb-4',
                pillTone,
            )}>
                <PillIcon className="w-4 h-4" />
                {pill}
            </div>
            <h3 className="text-2xl font-bold text-ink mb-2">{title}</h3>
            <p className="text-ink-muted text-sm leading-relaxed max-w-lg mx-auto">{subtitle}</p>
        </StepBlock>
    )
}

/** One entering block. Delay staggers them down the step. */
export function StepBlock({
    children, className, delay = 0,
}: {
    children: ReactNode
    className?: string
    delay?: number
}) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, delay, ease: 'easeOut' }}
            className={className}
        >
            {children}
        </motion.div>
    )
}

export function FieldLabel({
    children, required, hint,
}: {
    children: ReactNode
    required?: boolean
    hint?: string
}) {
    return (
        <label className="block text-sm font-semibold text-ink mb-2">
            {children}
            {required && <span className="text-red-500 ml-0.5">*</span>}
            {hint && (
                <span className="ml-2 text-xs font-normal text-ink-muted">{hint}</span>
            )}
        </label>
    )
}

/**
 * A text field big enough to be the subject of its step.
 *
 * `state` paints the border: an address that will work is worth confirming
 * as much as one that will not is worth flagging, and the border is where
 * the eye already is.
 */
export function BigInput({
    state = 'idle', icon: Icon, ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
    state?: 'idle' | 'valid' | 'invalid'
    icon?: LucideIcon
}) {
    return (
        <div className="relative group">
            {Icon && (
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-indigo-500 transition-colors pointer-events-none">
                    <Icon className="w-5 h-5" />
                </div>
            )}
            <input
                {...props}
                className={cn(
                    'w-full py-3.5 text-base rounded-xl border-2 bg-canvas-elevated text-ink placeholder:text-ink-muted outline-none transition-colors duration-150',
                    Icon ? 'pl-12 pr-4' : 'px-4',
                    state === 'invalid'
                        ? 'border-rose-400 dark:border-rose-500/70 focus:ring-4 focus:ring-rose-500/10'
                        : state === 'valid'
                            ? 'border-emerald-400 dark:border-emerald-500/60 focus:ring-4 focus:ring-emerald-500/10'
                            : 'border-black/[0.10] dark:border-white/[0.12] focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10',
                )}
            />
        </div>
    )
}

export function BigTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return (
        <textarea
            {...props}
            className={cn(
                'w-full px-4 py-3.5 text-sm rounded-xl border-2 border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated text-ink placeholder:text-ink-muted outline-none transition-colors duration-150 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 resize-none font-mono',
                props.className,
            )}
        />
    )
}

/** A pill row for a small closed set — expiry, seat caps. */
export function BigChipRow<T extends string | number | null>({
    options, value, onChange,
}: {
    options: { value: T; label: string; sublabel?: string }[]
    value: T
    onChange: (v: T) => void
}) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {options.map(opt => {
                const on = value === opt.value
                return (
                    <button
                        key={String(opt.value)}
                        type="button"
                        onClick={() => onChange(opt.value)}
                        className={cn(
                            'px-3 py-3 rounded-xl border-2 text-center transition-colors duration-150',
                            on
                                ? 'border-indigo-500 bg-indigo-500/[0.07]'
                                : 'border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated hover:border-indigo-500/40',
                        )}
                    >
                        <span className={cn(
                            'block text-sm font-semibold',
                            on ? 'text-indigo-600 dark:text-indigo-400' : 'text-ink',
                        )}>
                            {opt.label}
                        </span>
                        {opt.sublabel && (
                            <span className="block text-[10px] text-ink-muted mt-0.5">
                                {opt.sublabel}
                            </span>
                        )}
                    </button>
                )
            })}
        </div>
    )
}

export function Hint({ children, tone }: { children: ReactNode; tone?: 'warn' }) {
    return (
        <p className={cn(
            'text-xs mt-2 leading-relaxed',
            tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-ink-muted',
        )}>
            {children}
        </p>
    )
}
