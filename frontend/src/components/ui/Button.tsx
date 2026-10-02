/**
 * Button and IconButton — the app's one set of button styles.
 *
 * Every surface used to spell its own: a dozen near-identical class strings per drawer, each
 * with its own hover, focus (often none) and disabled treatment. These carry the variants the
 * product uses, a visible keyboard focus ring, a real disabled state and a loading state that
 * keeps the button's width. Tokens only — no alpha on the CSS-variable tokens.
 */
import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from './HoverTip'

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent'

const buttonVariants = cva(
  cn('inline-flex items-center justify-center font-semibold whitespace-nowrap select-none',
    'transition-[background-color,color,box-shadow,filter] duration-150',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none', FOCUS),
  {
    variants: {
      variant: {
        primary: 'bg-accent-lineage text-white shadow-sm shadow-accent-lineage/25 hover:brightness-110 active:brightness-95',
        secondary: 'bg-canvas-elevated text-ink border border-glass-border hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
        subtle: 'bg-black/[0.04] dark:bg-white/[0.06] text-ink hover:bg-black/[0.07] dark:hover:bg-white/10',
        ghost: 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
        danger: 'bg-rose-600 text-white shadow-sm shadow-rose-600/25 hover:bg-rose-500',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-lg',
        md: 'h-9 px-3.5 text-sm gap-2 rounded-xl',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

type Icon = ComponentType<{ className?: string }>

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner in place of the icon and disables the button (`aria-busy`). */
  loading?: boolean
  leftIcon?: Icon
  rightIcon?: Icon
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, loading = false, leftIcon: Left, rightIcon: Right, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const iconCls = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    >
      {loading ? <Loader2 className={cn(iconCls, 'animate-spin')} aria-hidden /> : Left ? <Left className={iconCls} aria-hidden /> : null}
      {children}
      {Right && !loading && <Right className={iconCls} aria-hidden />}
    </button>
  )
})

const iconButtonVariants = cva(
  cn('inline-flex items-center justify-center rounded-lg transition-colors duration-150',
    'disabled:opacity-40 disabled:cursor-not-allowed', FOCUS),
  {
    variants: {
      variant: {
        ghost: 'text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10',
        subtle: 'text-ink bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/10',
        danger: 'text-ink-muted hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10',
      },
      size: { sm: 'w-7 h-7', md: 'w-8 h-8' },
      active: { true: 'text-ink bg-black/[0.06] dark:bg-white/10', false: '' },
    },
    defaultVariants: { variant: 'ghost', size: 'md', active: false },
  },
)

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'>,
    VariantProps<typeof iconButtonVariants> {
  icon: Icon
  /** Required: an icon alone says nothing to a screen reader. Also the tooltip's lead. */
  label: string
  /** A tooltip naming the action (on by default); `detail` adds a quieter second line. */
  tip?: boolean
  detail?: ReactNode
  shortcut?: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Glyph, label, tip = true, detail, shortcut, variant, size, active, className, type = 'button', ...rest },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(iconButtonVariants({ variant, size, active }), className)}
      {...rest}
    >
      <Glyph className={size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'} aria-hidden />
    </button>
  )
  return tip ? <HoverTip label={label} detail={detail} shortcut={shortcut} className="inline-flex">{button}</HoverTip> : button
})
