/**
 * How a drawer names an entity: what a reader knows it by — its name and its type — with its
 * identifier as a quieter detail beneath, one click to copy. The name opens the entity.
 */
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useEntityColorSet, useEntityTypeLabel } from '@/hooks/useEntityVisual'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/Button'
import type { Endpoint } from '../relationship/useEndpoints'

/** An entity type as a small tag in the type's own colour. */
export function EntityTypeTag({ typeId, className }: { typeId: string; className?: string }) {
  const label = useEntityTypeLabel(typeId)
  const colors = useEntityColorSet(typeId)
  return (
    <span
      className={cn('inline-block px-1.5 py-px rounded text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap', className)}
      style={{ backgroundColor: colors.bg, color: colors.text }}
    >
      {label}
    </span>
  )
}

/** An identifier, set small and monospaced, with a copy button beside it. */
export function CopyableId({ id, className }: { id: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(id)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <span className={cn('group/id flex items-center gap-1 min-w-0', className)}>
      <code className="min-w-0 truncate text-[11px] font-mono text-ink-muted" title={id}>{id}</code>
      <IconButton
        icon={copied ? Check : Copy}
        label={copied ? 'Copied' : 'Copy ID'}
        size="sm"
        onClick={copy}
        className="shrink-0 w-6 h-6 opacity-60 group-hover/id:opacity-100 focus-visible:opacity-100"
      />
    </span>
  )
}

/** An entity by name and type, its id beneath. */
export function EntityRef({ endpoint, onOpen }: { endpoint: Endpoint; onOpen?: (id: string) => void }) {
  return (
    <span className="block min-w-0">
      <span className="flex items-center gap-1.5 min-w-0">
        {onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(endpoint.id)}
            className="min-w-0 truncate text-left text-sm font-medium text-ink hover:underline underline-offset-2 focus-visible:outline-none focus-visible:underline"
          >
            {endpoint.name}
          </button>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium text-ink">{endpoint.name}</span>
        )}
        {endpoint.type && <EntityTypeTag typeId={endpoint.type} className="shrink-0" />}
      </span>
      <CopyableId id={endpoint.id} />
    </span>
  )
}
