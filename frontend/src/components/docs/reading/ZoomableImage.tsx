import { useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { Lightbox } from './Lightbox'

/**
 * An article image in a framed, rounded container with a hover "expand" hint;
 * clicking opens it full-size in the Lightbox.
 */
export function ZoomableImage({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false)
  if (!src) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={alt ? `Enlarge: ${alt}` : 'Enlarge image'}
        className="group relative my-5 block w-full overflow-hidden rounded-xl border border-glass-border bg-canvas-elevated shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
      >
        <img src={src} alt={alt ?? ''} loading="lazy" className="block w-full" />
        <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <Maximize2 className="h-3 w-3" /> Expand
        </span>
      </button>
      <Lightbox open={open} onClose={() => setOpen(false)} label={alt}>
        <img src={src} alt={alt ?? ''} className="block max-h-[82vh] w-auto rounded-lg" />
      </Lightbox>
    </>
  )
}
