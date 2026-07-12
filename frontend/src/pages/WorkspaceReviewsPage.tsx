/**
 * WorkspaceReviewsPage — the standalone review inbox at /workspaces/:wsId/reviews. Page
 * chrome (back link + header) around the shared WorkspaceReviewsInbox. Deep-linkable via
 * ?pr=<prId> (e.g. straight from the commit dialog after opening an MR).
 */
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { GitPullRequestArrow, ArrowLeft } from 'lucide-react'
import { useWorkspacesStore } from '@/store/workspaces'
import { WorkspaceReviewsInbox } from '@/features/reviews/components/WorkspaceReviewsInbox'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { PageContainer } from '@/components/layout/PageContainer'

export function WorkspaceReviewsPage() {
  const { wsId } = useParams<{ wsId: string }>()
  const [searchParams] = useSearchParams()
  const workspaceName = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === wsId)?.name)

  useDocumentTitle(workspaceName ? `Reviews · ${workspaceName}` : 'Reviews')

  if (!wsId) return null

  return (
    <PageContainer className="py-8">
      <div className="mb-8">
        <Link to={`/workspaces/${wsId}`} className="inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink mb-4">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to workspace
        </Link>
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-11 h-11 rounded-2xl bg-accent-lineage/10 border border-accent-lineage/20 shrink-0">
            <GitPullRequestArrow className="w-6 h-6 text-accent-lineage" />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-ink leading-tight">Review Center</h1>
            <p className="text-sm text-ink-muted mt-0.5">Merge requests across {workspaceName ?? 'this workspace'}</p>
          </div>
        </div>
      </div>

      <WorkspaceReviewsInbox wsId={wsId} initialPrId={searchParams.get('pr')} />
    </PageContainer>
  )
}
