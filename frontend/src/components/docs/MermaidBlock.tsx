import { useEffect, useState } from 'react'
import { Code, Eye, Maximize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppliedTheme } from '@/hooks/useAppliedTheme'
import { Lightbox } from './reading/Lightbox'

let mermaidMod: Promise<typeof import('mermaid')> | null = null
function loadMermaid() {
  if (!mermaidMod) mermaidMod = import('mermaid')
  return mermaidMod
}

let renderCounter = 0

interface MermaidBlockProps {
  code: string
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const isDark = useAppliedTheme()
  const [showSource, setShowSource] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [svgHtml, setSvgHtml] = useState<string | null>(null)

  // Re-render when the code changes OR the theme flips, so a diagram always
  // matches the surrounding page in both light and dark.
  useEffect(() => {
    let cancelled = false
    async function render() {
      try {
        const mermaid = (await loadMermaid()).default
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          securityLevel: 'loose',
          fontFamily: 'Inter Variable, Inter, system-ui, sans-serif',
        })
        const id = `mermaid-${++renderCounter}`
        const { svg } = await mermaid.render(id, code)
        if (!cancelled) {
          setSvgHtml(svg)
          setError(null)
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to render diagram')
        }
      }
    }
    render()
    return () => {
      cancelled = true
    }
  }, [code, isDark])

  if (showSource) {
    return (
      <div className="relative my-4">
        <button
          onClick={() => setShowSource(false)}
          className="absolute top-2 right-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-ink-muted hover:text-ink bg-canvas-elevated border border-glass-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
        >
          <Eye className="w-3.5 h-3.5" />
          Diagram
        </button>
        <pre className="rounded-xl p-4 overflow-x-auto text-sm bg-canvas-elevated border border-glass-border">
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  if (error) {
    return (
      <div className="my-4 p-4 rounded-xl bg-red-500/5 border border-red-500/20 text-sm text-red-500">
        <p className="font-medium mb-2">Diagram rendering failed</p>
        <pre className="text-xs overflow-x-auto opacity-70">{code}</pre>
      </div>
    )
  }

  return (
    <div className="group relative my-4">
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
        {svgHtml && (
          <button
            onClick={() => setZoom(true)}
            aria-label="Enlarge diagram"
            title="Enlarge diagram"
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-ink-muted hover:text-ink bg-canvas-elevated/80 border border-glass-border opacity-0 transition-all group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={() => setShowSource(true)}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-ink-muted hover:text-ink bg-canvas-elevated/80 border border-glass-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
        >
          <Code className="w-3.5 h-3.5" />
          Source
        </button>
      </div>
      {svgHtml ? (
        <>
          <div
            className="flex justify-center p-4 rounded-xl bg-canvas-elevated border border-glass-border overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto"
            dangerouslySetInnerHTML={{ __html: svgHtml }}
          />
          <Lightbox open={zoom} onClose={() => setZoom(false)} label="Diagram">
            <div dangerouslySetInnerHTML={{ __html: svgHtml }} />
          </Lightbox>
        </>
      ) : (
        <div
          className={cn(
            'flex justify-center p-4 rounded-xl bg-canvas-elevated border border-glass-border overflow-x-auto',
            'min-h-[100px] items-center',
          )}
        >
          <div className="w-5 h-5 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  )
}
