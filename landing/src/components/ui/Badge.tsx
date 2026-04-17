interface BadgeProps {
  children: React.ReactNode
  variant?: 'default' | 'coming-soon' | 'new'
}

const variants = {
  default: 'bg-accent-lineage/10 text-accent-lineage',
  'coming-soon': 'bg-ink-muted/10 text-ink-muted',
  new: 'bg-accent-business/10 text-accent-business',
}

export function Badge({ children, variant = 'default' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${variants[variant]}`}>
      {children}
    </span>
  )
}
