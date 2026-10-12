/**
 * Badge — a small label for a state or a count ("draft", "roll-up", "3 changed").
 * Tones × variants from one table, so a status reads the same wherever it appears.
 */
import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const TONES = {
  neutral: {
    soft: 'bg-black/[0.05] dark:bg-white/[0.08] text-ink-secondary',
    outline: 'border border-glass-border text-ink-secondary',
    solid: 'bg-slate-600 text-white',
  },
  accent: {
    soft: 'bg-accent-lineage/10 text-accent-lineage',
    outline: 'border border-accent-lineage/30 text-accent-lineage',
    solid: 'bg-accent-lineage text-white',
  },
  success: {
    soft: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    outline: 'border border-emerald-500/30 text-emerald-700 dark:text-emerald-300',
    solid: 'bg-emerald-600 text-white',
  },
  warning: {
    soft: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    outline: 'border border-amber-500/30 text-amber-700 dark:text-amber-300',
    solid: 'bg-amber-500 text-black',
  },
  danger: {
    soft: 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
    outline: 'border border-rose-500/30 text-rose-700 dark:text-rose-300',
    solid: 'bg-rose-600 text-white',
  },
  info: {
    soft: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    outline: 'border border-sky-500/30 text-sky-700 dark:text-sky-300',
    solid: 'bg-sky-600 text-white',
  },
} as const

export type BadgeTone = keyof typeof TONES
export type BadgeVariant = keyof (typeof TONES)['neutral']

const badgeVariants = cva('inline-flex items-center gap-1 font-semibold whitespace-nowrap', {
  variants: {
    size: {
      sm: 'px-1.5 py-px rounded text-[10px] leading-4',
      md: 'px-2 py-0.5 rounded-md text-[11px] leading-4',
    },
    caps: { true: 'uppercase tracking-wide', false: '' },
  },
  defaultVariants: { size: 'sm', caps: false },
})

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  tone?: BadgeTone
  variant?: BadgeVariant
}

export function Badge({ tone = 'neutral', variant = 'soft', size, caps, className, ...rest }: BadgeProps) {
  return <span className={cn(badgeVariants({ size, caps }), TONES[tone][variant], className)} {...rest} />
}
