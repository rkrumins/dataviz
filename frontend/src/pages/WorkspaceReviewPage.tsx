/**
 * WorkspaceReviewPage — one review, on a page of its own at /workspaces/:wsId/reviews/:prId.
 * Deep-linkable to a change (?change=<entityId>) or a thread (?thread=<threadId>).
 */
import { useParams } from 'react-router-dom'
import { useWorkspacesStore } from '@/store/workspaces'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { ReviewPage } from '@/features/reviews/page/ReviewPage'

export function WorkspaceReviewPage() {
  const { wsId, prId } = useParams<{ wsId: string; prId: string }>()
  const workspaceName = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === wsId)?.name)

  useDocumentTitle(workspaceName ? `Review · ${workspaceName}` : 'Review')

  if (!wsId || !prId) return null
  // A review of its own: moving to another starts afresh.
  return <ReviewPage key={prId} wsId={wsId} prId={prId} />
}
