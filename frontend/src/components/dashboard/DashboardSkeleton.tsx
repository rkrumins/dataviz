import { cn } from '@/lib/utils'
import { WorkspaceCardSkeleton } from '@/components/admin/workspace/WorkspaceCardSkeleton'
import { PageContainer } from '@/components/layout/PageContainer'

/**
 * DashboardSkeleton — content-shaped placeholder shown while the dashboard's
 * workspaces load, in place of a centered spinner. Painting the real shell
 * (hero + Active Environments grid) instantly makes the wait feel shorter and
 * stops the layout from jumping when data arrives. Uses the same
 * <PageContainer> as the real Dashboard, so the geometry cannot drift apart —
 * it once did, and because the skeleton reproduced the bug faithfully, the
 * broken layout looked perfectly consistent while loading.
 */
function Bar({ className }: { className?: string }) {
  return <div className={cn('rounded bg-black/5 dark:bg-white/5', className)} />
}

export function DashboardSkeleton() {
  return (
    <div className="w-full h-full bg-canvas overflow-y-auto custom-scrollbar">
      <PageContainer className="pb-28">
        {/* Hero — centered pill + heading + search, matching DashboardHero */}
        <div className="flex flex-col items-center text-center pt-16 pb-10 px-6 animate-pulse">
          <Bar className="h-7 w-44 rounded-full mb-6" />
          <Bar className="h-9 w-[26rem] max-w-full mb-3" />
          <Bar className="h-9 w-72 max-w-full mb-7" />
          <Bar className="h-14 w-full max-w-2xl rounded-2xl" />
          <div className="flex flex-wrap justify-center gap-2 mt-6">
            <Bar className="h-9 w-28 rounded-xl" />
            <Bar className="h-9 w-28 rounded-xl" />
            <Bar className="h-9 w-28 rounded-xl" />
            <Bar className="h-9 w-24 rounded-xl" />
          </div>
        </div>

        {/* Active Environments header */}
        <div className="mt-6 mb-6 flex items-center gap-3 animate-pulse">
          <Bar className="w-9 h-9 rounded-xl" />
          <div className="space-y-2">
            <Bar className="h-5 w-48" />
            <Bar className="h-3 w-64" />
          </div>
        </div>

        {/* Workspace card grid (each card self-pulses) */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <WorkspaceCardSkeleton key={i} />
          ))}
        </div>
      </PageContainer>
    </div>
  )
}
