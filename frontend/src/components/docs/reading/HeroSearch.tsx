import { Search } from 'lucide-react'
import { formatShortcut } from '@/lib/platform'
import { prefetchSearchIndex } from '@/components/docs/search/useDocsSearchIndex'
import { useReader } from './ReaderContext'

/**
 * A hub's search box. It opens Search everything — with whatever was typed
 * — so the hub and the dialog are one search: the same index and ranking,
 * sections and FAQ answers included.
 */
export function HeroSearch({ placeholder }: { placeholder: string }) {
  const reader = useReader()
  return (
    <div className="mt-7 max-w-xl relative">
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden />
      <input
        type="text"
        value=""
        onChange={(e) => reader?.openSearch(e.target.value)}
        onClick={() => reader?.openSearch()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            reader?.openSearch()
          }
        }}
        onFocus={prefetchSearchIndex}
        onMouseEnter={prefetchSearchIndex}
        placeholder={placeholder}
        aria-label="Search the guide and the docs"
        aria-haspopup="dialog"
        autoComplete="off"
        className="input pl-11 pr-16 h-12 text-sm w-full shadow-sm cursor-text"
      />
      <kbd className="hidden sm:inline-flex absolute right-3 top-1/2 -translate-y-1/2 items-center rounded border border-glass-border bg-canvas px-1.5 py-0.5 text-[10px] text-ink-muted pointer-events-none">
        {formatShortcut('mod+k')}
      </kbd>
    </div>
  )
}
