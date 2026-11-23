/**
 * WorkspaceReviewsPage — the old address of one workspace's review inbox,
 * /workspaces/:wsId/reviews. The Review Center at /reviews now holds every
 * workspace's reviews, with a picker; this sends an older link (a notification,
 * a bookmark) there, scoped to its workspace, keeping `?queue=` and `?pr=`.
 * A review's own page is still /workspaces/:wsId/reviews/:prId.
 */
import { Navigate, useLocation, useParams } from 'react-router-dom'

export function WorkspaceReviewsPage() {
  const { wsId } = useParams<{ wsId: string }>()
  const { search } = useLocation()
  if (!wsId) return <Navigate to="/reviews" replace />
  const params = new URLSearchParams(search)
  params.set('workspace', wsId)
  return <Navigate to={`/reviews?${params}`} replace />
}
