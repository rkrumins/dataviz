/**
 * InformationalColumnsNote — what a file says about where its rows sat, and that it is skipped.
 *
 * Every export of entities can carry five informational columns, an entity's parent and path
 * (`lib/ancestryColumns`). A file brought back holds them, so before anything is sent the dialog
 * says, quietly, that they won't be imported: the import never reads them (the server's contract,
 * and the simple files' property columns), so nobody wonders whether `path` is about to become a
 * property of every row. Read from the head of the file alone; a workbook, which the server reads,
 * says nothing here.
 */
import { useEffect, useState } from 'react'
import { FolderTree } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'
import { parseCsv } from '@/components/playground/ownData'
import { ANCESTRY_COLUMNS, isAncestryColumn } from '@/lib/ancestryColumns'
import { detectFormat } from '@/services/importExportApiService'
import { usePersonaMode } from '@/store/persona'

/** How much of a file is read for its columns: a header, or the first records. */
const HEAD_BYTES = 65536

/** The informational columns `file` carries, as it names them. */
export async function informationalColumnsOf(file: File): Promise<string[]> {
  const format = await detectFormat(file)
  if (format === 'xlsx') return []
  const head = (await file.slice(0, HEAD_BYTES).text()).replace(/^\uFEFF/, '')
  if (format === 'json' || format === 'ndjson') {
    return ANCESTRY_COLUMNS.filter((c) => new RegExp(`"${c}"\\s*:`).test(head))
  }
  const firstLine = head.split(/\r?\n/, 1)[0] ?? ''
  return parseCsv(firstLine).headers.filter(isAncestryColumn)
}

export function InformationalColumnsNote({ files }: { files: readonly File[] }) {
  const persona = usePersonaMode()
  const [columns, setColumns] = useState<string[]>([])
  useEffect(() => {
    let live = true
    Promise.all(files.map((f) => informationalColumnsOf(f).catch(() => [] as string[])))
      .then((found) => { if (live) setColumns([...new Set(found.flat())]) })
    return () => { live = false }
  }, [files])
  if (columns.length === 0) return null
  const n = columns.length
  const technical = persona === 'technical'
  return (
    <div role="note" aria-label="Columns the import skips"
      className="flex items-start gap-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] px-3 py-2 animate-in fade-in duration-200">
      <FolderTree className="w-3.5 h-3.5 text-ink-muted mt-0.5 flex-shrink-0" />
      <p className="text-[11px] text-ink-muted leading-relaxed">
        <HoverTip
          label="Where each row sat when the file was exported"
          detail={technical
            ? 'Informational: an export writes them and an import never reads them. Containment edges say where an entity sits.'
            : 'They describe the file, not your data: importing it moves nothing.'}>
          <span className="font-medium text-ink-secondary underline decoration-dotted underline-offset-2 cursor-help">
            {n} informational {n === 1 ? 'column' : 'columns'}
          </span>
        </HoverTip>
        {' '}({technical ? columns.join(', ') : 'parent, path'}) will be skipped.
      </p>
    </div>
  )
}
