/**
 * Small, shared wording and formatting for view files and view versions.
 *
 * View versions are the history of a view's DESIGN. The copy here never borrows graph version
 * control's words (commit, publish, revert): the two sit side by side in the product and must not
 * be mistaken for each other.
 */
import type { UpdateStatus } from '@/services/viewTransferApiService'
import type { ViewVersionSource } from '@/services/viewVersionsApiService'

/** Mirrors the server's filename slug (`view_transfer._slug`), so the preview names the file the
 *  download will actually have. */
export function viewFileSlug(name: string | null | undefined): string {
  const slug = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/g, '')
  return slug || 'view'
}

export function viewFileName(name: string | null | undefined, version: number | null): string {
  return `${viewFileSlug(name)}${version ? `.v${version}` : ''}.view.json`
}

/** The name of a package of the view with its data (the server names the download the same). */
export function viewPackageName(name: string | null | undefined, version: number | null): string {
  return `${viewFileSlug(name)}${version ? `.v${version}` : ''}.view-package.zip`
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/** `sha256:3f2a9c…` → `3f2a9c1b`: enough to compare by eye. */
export function shortHash(hash: string | null | undefined, length = 8): string {
  if (!hash) return ''
  return hash.replace(/^sha256:/, '').slice(0, length)
}

export function percent(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined) return '—'
  const value = rate * 100
  if (value === 100 || value === 0) return `${value.toFixed(0)}%`
  return `${value.toFixed(digits)}%`
}

export const VERSION_SOURCE_LABEL: Record<ViewVersionSource, string> = {
  baseline: 'History starts',
  create: 'Created',
  wizard: 'Saved in the wizard',
  import: 'Imported',
  restore: 'Restored',
  promote: 'From a draft',
  export: 'Saved for export',
  manual: 'Saved',
  snapshot: 'Saved automatically',
}

export function pluralize(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

/** How a file stands against a view here that it already is. */
export const UPDATE_STATUS_META: Record<UpdateStatus, {
  label: string
  detail: string
  tone: 'emerald' | 'indigo' | 'amber' | 'slate'
}> = {
  up_to_date: { label: 'Already up to date', detail: 'This view already has exactly this design.', tone: 'emerald' },
  fast_forward: { label: 'The file is newer', detail: 'Nothing has changed here since they last matched, so importing it loses nothing here.', tone: 'indigo' },
  diverged: { label: 'Both changed', detail: 'Both this view and the file changed since they last matched.', tone: 'amber' },
  file_is_older: { label: 'The file is older', detail: 'This view has moved on since this file was made. Importing it goes back.', tone: 'amber' },
  unrelated: { label: 'No shared history', detail: 'This view and the file have no version in common.', tone: 'slate' },
}

export const TONE_CHIP: Record<'emerald' | 'indigo' | 'amber' | 'slate' | 'rose', string> = {
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  rose: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
}
