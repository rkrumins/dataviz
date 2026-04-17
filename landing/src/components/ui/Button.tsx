import { motion } from 'framer-motion'

type Variant = 'primary' | 'secondary' | 'ghost'

interface ButtonProps {
  children: React.ReactNode
  variant?: Variant
  href?: string
  className?: string
  onClick?: () => void
  icon?: React.ReactNode
}

const base = 'inline-flex items-center gap-2 font-medium rounded-xl px-6 py-3 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage focus-visible:ring-offset-2'

const variants: Record<Variant, string> = {
  primary:
    'bg-accent-lineage text-white hover:bg-indigo-500 shadow-md hover:shadow-glow',
  secondary:
    'glass-panel text-ink hover:bg-canvas-elevated',
  ghost:
    'text-ink-secondary hover:text-ink hover:bg-canvas-elevated',
}

export function Button({ children, variant = 'primary', href, className = '', onClick, icon }: ButtonProps) {
  const classes = `${base} ${variants[variant]} ${className}`

  const inner = (
    <>
      {icon}
      {children}
    </>
  )

  if (href) {
    return (
      <motion.a
        href={href}
        className={classes}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        target={href.startsWith('http') ? '_blank' : undefined}
        rel={href.startsWith('http') ? 'noopener noreferrer' : undefined}
      >
        {inner}
      </motion.a>
    )
  }

  return (
    <motion.button
      className={classes}
      onClick={onClick}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
    >
      {inner}
    </motion.button>
  )
}
