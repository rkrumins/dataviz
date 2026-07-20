import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/**
 * A full-viewport overlay that enlarges a diagram or image for a closer look.
 * Closes on Escape or a backdrop click; content is centered and scaled to fit.
 */
export function Lightbox({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean
  onClose: () => void
  label?: string
  children: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label ?? 'Enlarged view'}
      onClick={onClose}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm p-6 animate-fade-in"
    >
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
      >
        <X className="h-5 w-5" />
      </button>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[92vw] overflow-auto rounded-2xl bg-canvas-elevated p-4 shadow-2xl [&_svg]:h-auto [&_svg]:max-w-full"
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
