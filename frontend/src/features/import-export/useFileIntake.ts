/**
 * useFileIntake — the files a person drops or picks for an import, read as they arrive
 * (`fileRows.readFiles`).
 *
 * It keeps what goes together: one standard file (or one the server reads, such as an Excel
 * workbook) on its own, or the simple files — a things file and a connections file, or one JSON
 * file of both. A file of the same kind replaces the one before it, and one it can't read is named
 * and left out, the others kept.
 *
 * What goes up (`upload`): a standard file as it is, in the format detected from it (which the
 * person may change); the simple files as one NDJSON file of the standard's rows, named after them
 * and dated as the latest of them. The upload resumes by name, size, date and format, so the same
 * files chosen again pick it up where it stopped.
 */
import { useCallback, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import {
  detectFormat, importLimit, MAX_IMPORT_BYTES, triggerBrowserDownload, type ImportFormat,
} from '@/services/importExportApiService'
import { TEMPLATE_FILES } from '@/components/playground/ownData'
import { prettyBytes } from './format'
import { fileRole, readFiles, toImportFile, type FileRead, type TypeMap } from './fileRows'

const UNSUPPORTED: Record<string, string> = {
  xls: 'legacy Excel file', numbers: 'Numbers file', parquet: 'Parquet file', zip: 'Zip archive',
}

function unsupportedReason(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() || ''
  return UNSUPPORTED[ext]
    ? `${UNSUPPORTED[ext]}s aren't supported yet. Please open it and 'Save As' CSV, then import that file.`
    : null
}

/** Refused before any of it uploads: the server holds the same limits. */
function tooLargeReason(size: number, format: ImportFormat): string | null {
  const cap = importLimit(format)
  if (size <= cap) return null
  return format === 'json' || format === 'xlsx'
    ? `This file is ${prettyBytes(size)}. A${format === 'json' ? ' JSON' : 'n Excel'} file is read whole, so one import `
      + `of it can be at most ${prettyBytes(cap)}. Export NDJSON or CSV instead: they can be up to ${prettyBytes(MAX_IMPORT_BYTES)}.`
    : `This file is ${prettyBytes(size)}, and one import can be at most ${prettyBytes(cap)}. `
      + 'Split it into smaller files and import them one after another: each adds to the same draft.'
}

/** Download one of the simple templates (`TEMPLATE_FILES`). */
export function downloadSimpleTemplate(name: keyof typeof TEMPLATE_FILES): void {
  const type = name.endsWith('.json') ? 'application/json' : 'text/csv'
  const url = URL.createObjectURL(new Blob([TEMPLATE_FILES[name]], { type: `${type};charset=utf-8` }))
  triggerBrowserDownload(url, name)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

type Role = Awaited<ReturnType<typeof fileRole>>

export function useFileIntake() {
  const [files, setFiles] = useState<File[]>([])
  const [read, setRead] = useState<FileRead | null>(null)
  const [reading, setReading] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [format, setFormatState] = useState<ImportFormat>('csv')
  const [autoDetected, setAutoDetected] = useState(false)
  const kept = useRef<{ file: File; role: Role }[]>([])
  const seq = useRef(0)

  /** Read the files kept now; a later change wins over a read still under way. */
  const settle = useCallback(async (problems: string[]) => {
    const mine = ++seq.current
    const now = kept.current.map(k => k.file)
    setFiles(now)
    setRead(null)
    setErrors(problems)
    setAutoDetected(false)
    if (!now.length) return
    setReading(true)
    try {
      const got = await readFiles(now)
      const fmt = got.passthrough ? await detectFormat(got.passthrough) : 'ndjson'
      if (mine !== seq.current) return
      setRead(got)
      setFormatState(fmt)
      setAutoDetected(!!got.passthrough)
    } catch (e) {
      if (mine === seq.current) setErrors([...problems, e instanceof Error ? e.message : 'These files couldn’t be read.'])
    } finally {
      if (mine === seq.current) setReading(false)
    }
  }, [])

  const add = useCallback(async (incoming: File[]) => {
    const problems: string[] = []
    for (const file of incoming) {
      let role: Role
      try {
        role = await fileRole(file)
      } catch (e) {
        problems.push(e instanceof Error ? e.message : `${file.name}: couldn’t be read.`)
        continue
      }
      const alone = role === 'whole' || role === 'both'
      kept.current = alone ? [{ file, role }] : [
        ...kept.current.filter(k => k.role !== role && k.role !== 'whole' && k.role !== 'both'),
        { file, role },
      ]
    }
    await settle(problems)
  }, [settle])

  const remove = useCallback((file: File) => {
    kept.current = kept.current.filter(k => k.file !== file)
    void settle([])
  }, [settle])

  const clear = useCallback(() => {
    kept.current = []
    void settle([])
  }, [settle])

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    void add(Array.from(e.dataTransfer.files ?? []))
  }, [add])

  /** For a file input's onChange: emptied after, so choosing the same file again reads it again. */
  const onPick = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''
    void add(picked)
  }, [add])

  const setFormat = useCallback((f: ImportFormat) => {
    setFormatState(f)
    setAutoDetected(false)
  }, [])

  /** What goes up, its types as `typeMap` maps them (for the simple files): the file and its format.
   *  `from`: the read as the person settled it — its things identified by another column, say
   *  (`withIdentifierColumn`) — else the files' own. */
  const upload = useCallback((typeMap: TypeMap, from: FileRead | null = read): { file: File; format: ImportFormat } | null => {
    if (!from) return null
    if (from.passthrough) return { file: from.passthrough, format: from.passthroughFormat ?? format }
    return { file: toImportFile(from, typeMap, files), format: 'ndjson' }
  }, [read, format, files])

  const warning = read?.passthrough
    ? unsupportedReason(read.passthrough.name) ?? tooLargeReason(read.passthrough.size, format)
    : null

  return {
    files, read, reading, errors, warning, dragging, setDragging, format, setFormat, autoDetected,
    add, remove, clear, onDrop, onPick, upload,
  }
}

export type FileIntake = ReturnType<typeof useFileIntake>
