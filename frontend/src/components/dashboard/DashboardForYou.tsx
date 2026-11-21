/**
 * DashboardForYou — what the Business view leads the Dashboard with, above the
 * reader's views: what is theirs to do, each with the one place to go.
 *
 *   * reviews asked of them, and theirs sent back (the sidebar's Reviews count);
 *   * their requests — for a workspace of their own, to join someone else's — and
 *     where each stands; with none, the way to ask, for someone who may;
 *   * the Playground, while there is one: how much of it they've used.
 *
 * Only what applies renders; with nothing at all, nothing does.
 */
import type { ComponentType, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Building2, Compass, FlaskConical, GitPullRequestArrow, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useFeature } from '@/store/features'
import { useNavPermission } from '@/store/auth'
import { useSidebarSpec } from '@/store/navCatalogue'
import { useReviewCenterCounts } from '@/features/versioning/hooks/useVersioning'
import { usePlayground } from '@/hooks/usePlayground'
import { useMyAccessRequests, WORKSPACE_DIRECTORY_FEATURE } from '@/hooks/useWorkspaceAccess'
import {
    WORKSPACE_REQUESTS_FEATURE, useCanAnswerWorkspaceRequests, useMyWorkspaceRequests, useRequestWorkspaceWizard,
} from '@/hooks/useWorkspaceRequests'
import { latestRequest } from '@/components/workspace-requests/WorkspaceRequestCard'
import type { WorkspaceRequest } from '@/services/workspaceRequestsService'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const REQUEST_STAGE: Record<WorkspaceRequest['status'], string> = {
    pending: 'With the platform team',
    changes_requested: 'They asked you a question — answer it to move on',
    approved: 'Ready — you’re its admin',
    declined: 'Declined — you can ask again',
    withdrawn: 'Withdrawn',
}

export function DashboardForYou() {
    // A tile with nothing to say renders nothing: the columns close up around the rest,
    // and with none at all the section goes.
    return (
        <section aria-label="Waiting on you"
            className="mb-10 grid gap-3 px-4 md:px-0 [grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr))] empty:hidden">
            <ReviewsTile />
            <RequestsTile />
            <PlaygroundTile />
        </section>
    )
}

function ReviewsTile() {
    const allowed = useNavPermission(useSidebarSpec('reviews'))
    const on = useFeature('versioningEnabled')
    const counts = useReviewCenterCounts(allowed && on).data?.counts
    if (!allowed || !on || !counts) return null
    const asked = counts.needs_review ?? 0
    const sentBack = counts.sent_back ?? 0
    return (
        <Tile
            icon={GitPullRequestArrow} tone="indigo" eyebrow="Reviews"
            title={asked > 0 ? `${plural(asked, 'review')} waiting for you` : sentBack > 0 ? `${plural(sentBack, 'change')} sent back to you` : 'No reviews waiting'}
            detail={asked > 0 && sentBack > 0 ? `And ${plural(sentBack, 'of yours', 'of yours')} sent back.` : asked + sentBack > 0 ? 'Read the change, then approve it or say what to fix.' : 'Changes you’re asked to look at arrive here.'}
            to="/reviews" cta={asked + sentBack > 0 ? 'Open reviews' : 'Review Center'} highlight={asked + sentBack > 0}
        />
    )
}

function RequestsTile() {
    const requestsOn = useFeature(WORKSPACE_REQUESTS_FEATURE)
    const canCreate = useCanAnswerWorkspaceRequests()
    const directoryOn = useFeature(WORKSPACE_DIRECTORY_FEATURE)
    const mine = useMyWorkspaceRequests().data
    const { requests: access } = useMyAccessRequests('open')
    const openWizard = useRequestWorkspaceWizard(s => s.openWizard)
    const latest = requestsOn ? latestRequest(mine) : null
    const joining = access?.length ?? 0

    if (latest || joining > 0) {
        const lines = [
            latest && `“${latest.name}” · ${REQUEST_STAGE[latest.status]}`,
            joining > 0 && `${plural(joining, 'request')} to join waiting`,
        ].filter(Boolean) as string[]
        return (
            <Tile
                icon={Send} tone="violet" eyebrow="Your requests"
                title={latest ? (latest.status === 'approved' ? 'Your workspace is ready' : 'Your workspace request') : 'Asking to join'}
                detail={lines.join(' · ')}
                meta={latest ? `Sent ${timeAgo(latest.createdAt)}` : undefined}
                to={latest ? (latest.status === 'approved' && latest.workspaceId ? `/workspaces/${latest.workspaceId}` : '/my/access?tab=workspaces') : '/my/access'}
                cta={latest?.status === 'approved' ? 'Open it' : latest?.status === 'changes_requested' ? 'Answer' : 'Follow them'}
                highlight={latest?.status === 'changes_requested' || latest?.status === 'approved'}
            />
        )
    }
    if (requestsOn && !canCreate) {
        return (
            <Tile
                icon={Building2} tone="violet" eyebrow="Your own workspace"
                title="Need a workspace of your own?"
                detail="Ask the platform team for one — bring your teammates, and you’ll be its admin."
                onClick={() => openWizard()} cta="Request a workspace"
            />
        )
    }
    if (directoryOn) {
        return (
            <Tile
                icon={Compass} tone="violet" eyebrow="Workspaces"
                title="Looking for another team’s work?"
                detail="Browse what each team works on, and ask to join."
                to="/workspaces?tab=discover" cta="Find a workspace"
            />
        )
    }
    return null
}

function PlaygroundTile() {
    const info = usePlayground().data
    if (!info?.enabled || !info.exists) return null
    return (
        <Tile
            icon={FlaskConical} tone="fuchsia" eyebrow="Playground"
            title={info.joined ? 'Keep experimenting' : 'Try an idea, safely'}
            detail={info.joined
                ? `${info.graphsUsed} of ${info.graphQuota} graphs used — build, explore and share, apart from production.`
                : 'Build a graph of your own and explore it, apart from production.'}
            to="/playground" cta="Open the Playground"
        />
    )
}

const TONES = {
    indigo: { chip: 'from-indigo-500 to-violet-600 shadow-indigo-500/25', wash: 'from-indigo-500/[0.08]', ring: 'hover:border-indigo-500/40', cta: 'text-indigo-600 dark:text-indigo-400' },
    violet: { chip: 'from-violet-500 to-fuchsia-500 shadow-violet-500/25', wash: 'from-violet-500/[0.08]', ring: 'hover:border-violet-500/40', cta: 'text-violet-600 dark:text-violet-300' },
    fuchsia: { chip: 'from-fuchsia-500 to-pink-500 shadow-fuchsia-500/25', wash: 'from-fuchsia-500/[0.08]', ring: 'hover:border-fuchsia-500/40', cta: 'text-fuchsia-600 dark:text-fuchsia-300' },
}

function Tile({ icon: Icon, tone, eyebrow, title, detail, meta, to, onClick, cta, highlight }: {
    icon: ComponentType<{ className?: string }>
    tone: keyof typeof TONES
    eyebrow: string
    title: string
    detail: string
    meta?: string
    to?: string
    onClick?: () => void
    cta: string
    /** Something waits on the reader: the tile says so with its border. */
    highlight?: boolean
}) {
    const t = TONES[tone]
    const body: ReactNode = (
        <>
            <span aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br via-transparent to-transparent', t.wash)} />
            <span className="relative flex items-start gap-3">
                <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-md', t.chip)}>
                    <Icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{eyebrow}</span>
                    <span className="mt-0.5 block text-[15px] font-bold leading-snug text-ink">{title}</span>
                </span>
            </span>
            <span className="relative mt-2 block text-xs leading-relaxed text-ink-secondary">{detail}</span>
            <span className="relative mt-auto flex items-center justify-between gap-2 pt-3">
                <span className="text-[11px] text-ink-muted">{meta}</span>
                <span className={cn('inline-flex items-center gap-1 text-xs font-bold', t.cta)}>
                    {cta} <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
            </span>
        </>
    )
    const cls = cn(
        'glass-panel group relative flex flex-col overflow-hidden rounded-2xl border p-4 text-left transition-all duration-200',
        'hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
        highlight ? 'border-violet-500/35' : 'border-glass-border', t.ring,
    )
    return to ? <Link to={to} className={cls}>{body}</Link> : <button type="button" onClick={onClick} className={cls}>{body}</button>
}
