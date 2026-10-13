import { toUtcDate } from '@/lib/timeAgo'
import type { View } from '@/services/viewApiService'
import type { VisitWindow } from '@/store/visitWindows'

/** Whether a view is new or changed within the window — the card's ribbon. */
export function visitMark(view: Pick<View, 'createdAt' | 'updatedAt' | 'dataUpdatedAt'>, window: VisitWindow | null): 'new' | 'updated' | null {
  if (!window) return null
  const from = Date.parse(window.from)
  const to = Date.parse(window.to)
  const inWindow = (ts: string | null | undefined) => {
    const t = toUtcDate(ts)?.getTime()
    return t !== undefined && t >= from && t < to
  }
  if (inWindow(view.createdAt)) return 'new'
  return inWindow(view.updatedAt) || inWindow(view.dataUpdatedAt) ? 'updated' : null
}
