/**
 * RefusedRowsPanel — the rows an import refused, guided: how many for each reason, what to do about
 * each, and the rows themselves, filtered by reason.
 *
 * It opens at once from the job's own report (`summary.refused`: the counts, the fixes and the first
 * rows), with no request of its own. Every refused row loads only when asked, a page at a time, and
 * downloads as CSV — where each row is, what it is, why, and what to do — to fix in a spreadsheet.
 * The table draws at most `VISIBLE` rows, so a file with thousands refused stays snappy; the CSV
 * holds them all.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, Download, Lightbulb, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getRefusedRows, refusedRowsCsv, triggerBrowserDownload, whereText, type RefusedRow, type RefusedRows,
} from '@/services/importExportApiService'

/** Rows the table draws at most. */
export const VISIBLE = 1000
/** Rows a download fetches at most, a page at a time; past it, the API pages on (`after`). */
export const DOWNLOAD_CAP = 50_000
/** Records that are neither a node nor an edge: counted as the file is read, never listed. */
const NOT_A_RECORD = 'not_node_or_edge'

export interface RefusedRowsPanelProps {
  report: RefusedRows
  wsId: string
  graphId: string
  /** The import, to load every refused row; without it, the report's first rows only. */
  jobId?: string | null
}

export function RefusedRowsPanel({ report, wsId, graphId, jobId }: RefusedRowsPanelProps) {
  const codes = useMemo(() => Object.entries(report.byCode).sort((a, b) => b[1] - a[1]), [report.byCode])
  const fixes = report.fixes ?? {}
  const [code, setCode] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<RefusedRow[] | null>(null)
  const [nextAfter, setNextAfter] = useState<number | null>(null)
  const [busy, setBusy] = useState<'page' | 'csv' | null>(null)
  const [fetched, setFetched] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const rows = loaded ?? report.rows
  const shown = useMemo(() => (code ? rows.filter((r) => r.code === code) : rows), [rows, code])
  const listedTotal = report.total - (report.byCode[NOT_A_RECORD] ?? 0)
  const more = !!jobId && (loaded === null ? listedTotal > report.rows.length : nextAfter !== null)
  const of = code ? report.byCode[code] ?? 0 : report.total

  async function loadPage() {
    if (!jobId) return
    setBusy('page')
    setError(null)
    try {
      const first = loaded === null
      const page = await getRefusedRows(wsId, graphId, jobId, first ? null : nextAfter)
      setLoaded((prev) => (first ? page.rows : [...(prev ?? []), ...page.rows]))
      setNextAfter(page.nextAfter)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The refused rows could not be loaded.')
    } finally {
      setBusy(null)
    }
  }

  async function download() {
    setBusy('csv')
    setError(null)
    setFetched(0)
    try {
      let all: RefusedRow[] = rows
      if (jobId && listedTotal > rows.length) {
        all = []
        let after: number | null = null
        do {
          const page: { rows: RefusedRow[]; nextAfter: number | null } =
            await getRefusedRows(wsId, graphId, jobId, after)
          all.push(...page.rows)
          setFetched(all.length)
          after = page.nextAfter
        } while (after !== null && all.length < DOWNLOAD_CAP)
      }
      const url = URL.createObjectURL(new Blob([refusedRowsCsv(all, fixes)], { type: 'text/csv' }))
      triggerBrowserDownload(url, `refused-rows-${jobId ?? 'import'}.csv`)
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The refused rows could not be downloaded.')
    } finally {
      setBusy(null)
    }
  }

  const fixesShown = (code ? codes.filter(([c]) => c === code) : codes).filter(([c]) => fixes[c])
  return (
    <section aria-label="Refused rows"
      className="mt-5 rounded-2xl border border-amber-200/80 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/15 overflow-hidden">
      <header className="flex items-start gap-3 px-4 pt-4">
        <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 flex items-center justify-center flex-shrink-0">
          <AlertTriangle className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-ink">
            {report.total.toLocaleString()} row{report.total === 1 ? '' : 's'} refused
          </h4>
          <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">
            Each says where it is in your file — its line, or its sheet and row — why it was refused,
            and what to do.
          </p>
        </div>
        <button onClick={() => void download()} disabled={busy !== null}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors disabled:opacity-50">
          {busy === 'csv' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          {busy === 'csv' && fetched > 0 ? `${fetched.toLocaleString()} rows…` : 'Download CSV'}
        </button>
      </header>

      <div role="group" aria-label="Show the rows refused for" className="flex flex-wrap gap-1.5 px-4 mt-3">
        <ReasonChip active={code === null} onClick={() => setCode(null)}>All · {report.total.toLocaleString()}</ReasonChip>
        {codes.map(([c, n]) => (
          <ReasonChip key={c} active={code === c} onClick={() => setCode(code === c ? null : c)}>
            {n.toLocaleString()} <span className="font-mono">{c}</span>
          </ReasonChip>
        ))}
      </div>

      {fixesShown.length > 0 && (
        <ul className="px-4 mt-3 space-y-1.5" aria-label="What to do">
          {fixesShown.map(([c]) => (
            <li key={c} className="flex gap-2 text-[11px] text-ink leading-relaxed">
              <Lightbulb className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
              <span><span className="font-mono font-semibold">{c}</span>: {fixes[c]}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 max-h-60 overflow-auto border-t border-amber-200/60 dark:border-amber-900/40 bg-white/70 dark:bg-black/10">
        {shown.length > 0 ? (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-amber-50 dark:bg-slate-900 text-ink-muted">
              <tr>
                <th scope="col" className="text-left font-medium px-4 py-1.5 w-24">Where</th>
                <th scope="col" className="text-left font-medium py-1.5 pr-2 w-12">Kind</th>
                <th scope="col" className="text-left font-medium py-1.5 pr-2">Item</th>
                <th scope="col" className="text-left font-medium py-1.5 pr-4">Why</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, VISIBLE).map((r) => (
                <tr key={r.rowIndex} className="border-t border-black/5 dark:border-white/5 align-top">
                  <td className="px-4 py-1.5 font-mono text-ink whitespace-nowrap" title={`record ${r.rowIndex} of the file, from 0`}>
                    {whereText(r)}
                  </td>
                  <td className="py-1.5 pr-2 text-ink-muted">{r.kind}</td>
                  <td className="py-1.5 pr-2 text-ink max-w-[11rem] truncate" title={r.label}>{r.label || '—'}</td>
                  <td className="py-1.5 pr-4 text-ink-muted break-words">
                    <span className="font-mono text-ink">{r.code}</span>{r.reason ? ` — ${r.reason}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 py-3 text-[11px] text-ink-muted">
            {code === NOT_A_RECORD
              ? 'These records are counted as the file is read, and aren’t listed one by one.'
              : 'None of these rows is loaded yet: show them all to list them.'}
          </p>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 px-4 py-2.5 text-[11px] text-ink-muted border-t border-amber-200/60 dark:border-amber-900/40">
        <span>
          Showing {Math.min(shown.length, VISIBLE).toLocaleString()} of {of.toLocaleString()}
          {shown.length > VISIBLE ? ' — the CSV has every one' : ''}
        </span>
        {more && (
          <button onClick={() => void loadPage()} disabled={busy !== null}
            className="flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-300 hover:underline disabled:opacity-50">
            {busy === 'page' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {loaded === null ? `Show all ${listedTotal.toLocaleString()}` : 'Load more'}
          </button>
        )}
      </footer>
      {error && <p role="alert" className="px-4 pb-3 text-[11px] text-rose-600 dark:text-rose-400">{error}</p>}
    </section>
  )
}

function ReasonChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={cn('px-2 py-1 rounded-full text-[11px] font-medium border transition-colors',
        active
          ? 'bg-amber-500 border-amber-500 text-white shadow-sm'
          : 'bg-white/80 dark:bg-white/5 border-amber-200 dark:border-amber-900/60 text-ink hover:border-amber-400')}>
      {children}
    </button>
  )
}
