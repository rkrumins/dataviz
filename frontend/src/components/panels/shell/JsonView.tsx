/** A drawer's JSON tab: what it shows, read-only, for inspection — the
 *  shared `JsonTree`: highlighted, foldable, and one click from the
 *  clipboard. Built only while the tab is open. */
import { Code } from 'lucide-react'

import { JsonTree } from '@/components/ui/JsonTree'

export function JsonView({ data, label }: {
  data: unknown
  /** What the data is, e.g. "Entity data" — read as "Entity data as JSON". */
  label: string
}) {
  return (
    <div className="p-5">
      <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-ink-muted">
        <Code className="h-3.5 w-3.5" aria-hidden />
        Raw JSON
      </p>
      <JsonTree value={data} label={label} openDepth={3} />
    </div>
  )
}
