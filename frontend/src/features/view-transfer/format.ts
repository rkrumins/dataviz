/**
 * Small, shared wording and formatting for view files and view versions.
 *
 * View versions are the history of a view's DESIGN. The copy here never borrows graph version
 * control's words (commit, publish, revert): the two sit side by side in the product and must not
 * be mistaken for each other.
 */
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
