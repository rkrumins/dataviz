/** A drawer's JSON tab: what it shows, read-only, for inspection — serialised only while open. */
import { useMemo, useState } from 'react'
import { Check, Code, Copy } from 'lucide-react'
import { IconButton } from '@/components/ui/Button'

export function JsonView({ data, label }: {
  data: unknown
  /** Names the block for assistive tech, e.g. "Entity data as JSON". */
  label: string
}) {
  const json = useMemo(() => JSON.stringify(data, null, 2), [data])
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard?.writeText(json)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-ink-muted flex items-center gap-2">
          <Code className="w-3.5 h-3.5" aria-hidden />
          Raw JSON
        </span>
        <IconButton icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy JSON'} size="sm" onClick={() => { void copy() }} />
      </div>
      <pre
        className="w-full max-h-[520px] overflow-auto px-4 py-3 rounded-xl bg-black/[0.04] dark:bg-white/[0.04] border border-glass-border text-xs font-mono text-ink whitespace-pre-wrap break-words custom-scrollbar"
        aria-label={label}
        tabIndex={0}
      >
        {json}
      </pre>
    </div>
  )
}
