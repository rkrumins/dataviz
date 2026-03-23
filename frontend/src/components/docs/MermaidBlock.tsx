import { useEffect, useState } from 'react'
import { Code, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'

let mermaidPromise: Promise<typeof import('mermaid')> | null = null
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
        securityLevel: 'loose',
        fontFamily: 'Inter Variable, Inter, system-ui, sans-serif',
      })
      return m
    })
  }
  return mermaidPromise
}

let renderCounter = 0

interface MermaidBlockProps {
  code: string
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const [showSource, setShowSource] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [svgHtml, setSvgHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function render() {
      try {
        const mermaid = await loadMermaid()
        const id = `mermaid-${++renderCounter}`
        const { svg } = await mermaid.default.render(id, code)
        if (!cancelled) {
          setSvgHtml(svg)
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to render diagram')
        }
      }
    }

    render()
    return () => { cancelled = true }
  }, [code])

  if (showSource) {
    return (
      <div className="relative my-4">
        <button
          onClick={() => setShowSource(false)}
          className="absolute top-2 right-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-ink-muted hover:text-ink bg-canvas-elevated border border-glass-border transition-colors"
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
    <div className="relative my-4">
      <button
        onClick={() => setShowSource(true)}
        className="absolute top-2 right-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-ink-muted hover:text-ink bg-canvas-elevated/80 border border-glass-border transition-colors"
      >
        <Code className="w-3.5 h-3.5" />
        Source
      </button>
      {svgHtml ? (
        <div
          className="flex justify-center p-4 rounded-xl bg-canvas-elevated border border-glass-border overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      ) : (
        <div className={cn(
          'flex justify-center p-4 rounded-xl bg-canvas-elevated border border-glass-border overflow-x-auto',
          'min-h-[100px] items-center',
        )}>
          <div className="w-5 h-5 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  )
}
