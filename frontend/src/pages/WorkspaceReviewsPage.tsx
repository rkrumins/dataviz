/**
 * WorkspaceReviewsPage — the standalone review inbox at /workspaces/:wsId/reviews. Page
 * chrome (back link + header) around the shared WorkspaceReviewsInbox. Deep-linkable via
 * ?pr=<prId> (e.g. straight from the commit dialog after opening an MR).
 */
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { GitPullRequestArrow, ArrowLeft } from 'lucide-react'
import { useWorkspacesStore } from '@/store/workspaces'
import { WorkspaceReviewsInbox } from '@/features/reviews/components/WorkspaceReviewsInbox'

export function WorkspaceReviewsPage() {
  const { wsId } = useParams<{ wsId: string }>()
  const [searchParams] = useSearchParams()
  const workspaceName = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === wsId)?.name)

  if (!wsId) return null

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-6">
        <Link to={`/workspaces/${wsId}`} className="inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink mb-3">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to workspace
        </Link>
        <div className="flex items-center gap-2.5">
          <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-accent-lineage/10 border border-accent-lineage/20">
            <GitPullRequestArrow className="w-5 h-5 text-accent-lineage" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-ink leading-tight">Reviews</h1>
            <p className="text-sm text-ink-muted">Merge requests across {workspaceName ?? 'this workspace'}</p>
          </div>
        </div>
      </div>

      <WorkspaceReviewsInbox wsId={wsId} initialPrId={searchParams.get('pr')} />
    </div>
  )
}
