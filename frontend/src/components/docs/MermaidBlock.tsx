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
      const id = `mermaid-${++renderCounter}`
      try {
        const mermaid = (await loadMermaid()).default
        // Brand the diagrams from the app's live design tokens so they echo the
        // product (accent-bordered nodes on an elevated surface, muted lines)
        // and flip cleanly with the theme.
        const cs = getComputedStyle(document.documentElement)
        const g = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
        const accent = g('--nx-accent-lineage', '#6366f1')
        const bgEl = g('--nx-bg-elevated', isDark ? '#161b22' : '#ffffff')
        const bgCanvas = g('--nx-bg-canvas', isDark ? '#0d1117' : '#fafbfc')
        const textP = g('--nx-text-primary', isDark ? '#e6edf3' : '#1a1d21')
        const muted = g('--nx-accent-muted', '#64748b')
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'loose',
          // A diagram that fails to parse should surface OUR inline error, not
          // mermaid's full-page "Syntax Error" bomb graphic injected into the DOM.
          suppressErrorRendering: true,
          fontFamily: 'Inter Variable, Inter, system-ui, sans-serif',
          themeVariables: {
            darkMode: isDark,
            background: bgCanvas,
            primaryColor: bgEl,
            primaryBorderColor: accent,
            primaryTextColor: textP,
            secondaryColor: bgEl,
            secondaryBorderColor: muted,
            secondaryTextColor: textP,
            tertiaryColor: bgCanvas,
            tertiaryBorderColor: muted,
            tertiaryTextColor: textP,
            mainBkg: bgEl,
            nodeBorder: accent,
            nodeTextColor: textP,
            lineColor: muted,
            textColor: textP,
            titleColor: textP,
            clusterBkg: isDark ? 'rgba(99,102,241,0.08)' : 'rgba(99,102,241,0.05)',
            clusterBorder: muted,
            edgeLabelBackground: bgEl,
          },
        })
        const { svg } = await mermaid.render(id, code)
        if (!cancelled) {
          setSvgHtml(svg)
          setError(null)
        }
      } catch (e: unknown) {
        // Belt-and-suspenders: drop any temporary measuring node mermaid may
        // have left in the DOM on a failed render, so nothing leaks visually.
        document.getElementById(id)?.remove()
        document.querySelector(`#d${id}`)?.remove()
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
            {/* Claim a real width budget and override Mermaid's inline
                style="max-width:Npx" (important beats inline) so the diagram
                scales up to fill the modal instead of sitting at its small
                natural size; h-auto + the SVG's preserveAspectRatio keep it
                undistorted, max-h caps very tall diagrams. */}
            <div
              className="w-[88vw] max-w-[1600px] [&_svg]:!max-w-none [&_svg]:w-full [&_svg]:h-auto [&_svg]:max-h-[85vh]"
              dangerouslySetInnerHTML={{ __html: svgHtml }}
            />
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
