import { useState, useCallback, useEffect } from 'react'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useCanvasStore } from '@/store/canvas'
import { toLineageNode } from '@/utils/graph-converters'
import { Loader2, Search, Plus } from 'lucide-react'
import type { GraphNode } from '@/providers/GraphDataProvider'

interface SearchChildrenPanelProps {
    parentId: string
    parentName: string
    onClose: () => void
}

export function SearchChildrenPanel({ parentId, parentName, onClose }: SearchChildrenPanelProps) {
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<GraphNode[]>([])
    const [isLoading, setIsLoading] = useState(false)

    const provider = useGraphProvider()
    const addNodes = useCanvasStore((s) => s.addNodes)


    // Debounced search
    useEffect(() => {
        if (!query.trim()) {
            setResults([])
            return
        }

        const timer = setTimeout(async () => {
            setIsLoading(true)
            try {
                if (provider.getContainment) {
                    const response = await provider.getContainment({
                        parentUrn: parentId,
                        searchQuery: query,
                        limit: 10
                    })
                    setResults(response.children)
                } else {
                    const children = await provider.getChildren(parentId, { limit: 50 })
                    const q = query.toLowerCase()
                    const filtered = children.filter(
                        (c) =>
                            c.displayName?.toLowerCase().includes(q) ||
                            c.urn?.toLowerCase().includes(q)
                    )
                    setResults(filtered.slice(0, 10))
                }
            } catch (err) {
                console.error('Search failed', err)
            } finally {
                setIsLoading(false)
            }
        }, 300)

        return () => clearTimeout(timer)
    }, [query, parentId, provider])

    const handleAddResults = useCallback(() => {
        if (!results.length) return

        // Filter out already loaded nodes?
        // Canvas store handles duplicates by ID automatically in addNodes reducer logic?
        // "addNodes" in store/canvas.ts checks for unique IDs.

        const lineageNodes = results.map(toLineageNode)
        addNodes(lineageNodes)
        onClose()
    }, [results, addNodes, onClose])

    return (
        <div className="absolute top-full left-0 mt-2 w-64 bg-canvas-elevated border border-glass-border rounded-lg shadow-xl p-3 z-50">
            <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium text-ink-muted">Search in {parentName}</span>
            </div>

            <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search children..."
                    className="w-full bg-canvas border border-glass-border rounded px-2 pl-7 py-1 text-xs focus:ring-1 focus:ring-accent-lineage outline-none"
                />
                {isLoading && (
                    <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted animate-spin" />
                )}
            </div>

            {results.length > 0 && (
                <div className="mt-2 text-xs text-ink-muted">
                    Found {results.length} item{results.length !== 1 ? 's' : ''}
                </div>
            )}

            {results.length > 0 && (
                <button
                    onClick={handleAddResults}
                    className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-accent-lineage/10 hover:bg-accent-lineage/20 text-accent-lineage rounded text-xs font-medium transition-colors"
                >
                    <Plus className="w-3.5 h-3.5" />
                    Add to Graph
                </button>
            )}

            {query && !isLoading && results.length === 0 && (
                <div className="mt-2 text-xs text-ink-muted text-center italic">
                    No results found
                </div>
            )}
        </div>
    )
}
