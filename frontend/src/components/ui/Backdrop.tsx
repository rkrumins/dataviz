import { cn } from '@/lib/utils'

interface BackdropProps {
  /** Visibility. When false the backdrop is transparent AND pointer-events-none. */
  open: boolean
  onClick?: () => void
  /** Tailwind z-index utility, e.g. 'z-[60]'. Caller keeps its existing literal. */
  zClassName?: string
  /** Tint override, e.g. 'bg-black/60'. Defaults to 'bg-black/40'. */
  className?: string
}

/**
 * Plain CSS-transitioned full-screen backdrop. NEVER a motion element and NEVER
 * placed inside <AnimatePresence> — that is the entire point: it cannot be stranded
 * by AnimatePresence/StrictMode and shield the viewport. Generalizes the proven fix
 * in OntologySchemaPage.tsx (the "AnimatePresence freeze" workaround).
 *
 * Render it unconditionally and drive visibility via `open` — never `{open && <Backdrop/>}`.
 * Persistence + CSS toggle is what makes it safe.
 */
export function Backdrop({ open, onClick, zClassName = 'z-50', className }: BackdropProps) {
  return (
    <div
      aria-hidden
      onClick={onClick}
      className={cn(
        'fixed inset-0 transition-opacity duration-200',
        className ?? 'bg-black/40',
        zClassName,
        open ? 'opacity-100' : 'opacity-0 pointer-events-none',
      )}
    />
  )
}
