/**
 * useOnboardingProgress — the source of truth for the "Getting started" hub.
 *
 * Onboarding is organised into role-aware TRACKS rather than one flat list, so
 * every persona sees a path that fits them and nobody dead-ends on steps they
 * can't perform:
 *
 *   • Set up the platform  — admins / provider-readers: connect → assets →
 *                            workspace → ontology. Auto-detected from real counts.
 *   • Explore your data    — everyone: create a view, trace lineage.
 *   • Collaborate & govern — admins (invite team, access) and, when the
 *                            versioning flag is on, reviewing a change.
 *
 * Steps with a real signal (counts) tick themselves off; "learn"-style steps
 * with no persisted signal complete when the user acts on them (the hub records
 * a manual flag on click). The product tour is offered separately as a
 * persistent, replayable action — it is not a step here.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { LucideIcon } from 'lucide-react'
import {
  DatabaseZap, Boxes, Layers, Compass, GitBranch, PlusCircle,
  Users, ShieldCheck, GitPullRequest,
} from 'lucide-react'
import { providerService } from '@/services/providerService'
import { catalogService } from '@/services/catalogService'
import { workspaceService } from '@/services/workspaceService'
import { listViews } from '@/services/viewApiService'
import { usePreferencesStore } from '@/store/preferences'
import { usePermission, useAnyWorkspacePermission } from '@/store/auth'
import { useFeature } from '@/store/features'

/** The product tour the hub offers (as a persistent action, not a step). */
export const GETTING_STARTED_TOUR = 'getting-started'

export type OnboardingAccent = 'setup' | 'explore' | 'govern'

export interface OnboardingStep {
  id: string
  label: string
  description: string
  icon: LucideIcon
  done: boolean
  /** In-SPA route the CTA opens. */
  href?: string
  /** Guide slug for the step's contextual DocsLink. */
  guideSlug?: string
  /** No auto-signal — the step completes when the user acts on it (marked on click). */
  manual?: boolean
}

export interface OnboardingTrack {
  id: string
  title: string
  subtitle: string
  accent: OnboardingAccent
  icon: LucideIcon
  steps: OnboardingStep[]
  completedCount: number
  total: number
  allDone: boolean
}

export interface OnboardingProgressResult {
  tracks: OnboardingTrack[]
  /** Totals across every visible track. */
  completedCount: number
  total: number
  allDone: boolean
  isLoading: boolean
}

interface OnboardingCounts {
  providerCount: number
  catalogItemCount: number
  workspaceCount: number
  hasOntology: boolean
  viewCount: number
}

/**
 * Fetch the count sources in parallel. Best-effort: a rejected read (e.g. a
 * viewer who can't list providers) counts as zero rather than failing the whole
 * hub, mirroring IngestionPage's allSettled load.
 */
async function fetchOnboardingCounts(): Promise<OnboardingCounts> {
  const [providers, catalog, workspaces, views] = await Promise.allSettled([
    providerService.list(),
    catalogService.list(),
    workspaceService.list(),
    listViews({ limit: 1 }),
  ])

  const workspaceList = workspaces.status === 'fulfilled' ? workspaces.value : []

  return {
    providerCount: providers.status === 'fulfilled' ? providers.value.length : 0,
    catalogItemCount: catalog.status === 'fulfilled' ? catalog.value.length : 0,
    workspaceCount: workspaceList.length,
    hasOntology: workspaceList.some((ws) => ws.dataSources?.some((ds) => !!ds.ontologyId)),
    viewCount: views.status === 'fulfilled' ? views.value.total : 0,
  }
}

interface StepOpts { href?: string; guideSlug?: string; manual?: boolean }
function makeStep(
  id: string, label: string, description: string, icon: LucideIcon, done: boolean, opts: StepOpts = {},
): OnboardingStep {
  return { id, label, description, icon, done, ...opts }
}

function makeTrack(
  id: string, title: string, subtitle: string, accent: OnboardingAccent, icon: LucideIcon, steps: OnboardingStep[],
): OnboardingTrack {
  const completedCount = steps.filter((s) => s.done).length
  return { id, title, subtitle, accent, icon, steps, completedCount, total: steps.length, allDone: steps.length > 0 && completedCount === steps.length }
}

export function useOnboardingProgress(): OnboardingProgressResult {
  const { data, isPending } = useQuery({
    queryKey: ['onboarding-progress'],
    queryFn: fetchOnboardingCounts,
    staleTime: 30_000,
  })

  const manual = usePreferencesStore((s) => s.onboardingCompletedSteps)
  const isPlatformAdmin = usePermission('system:admin')
  const isOrgAdmin = usePermission('system:org-admin')
  const canReadProviders = useAnyWorkspacePermission('workspace:provider:read')
  const versioningEnabled = useFeature('versioningEnabled')

  // Who sees what. Setup is for people who can actually connect data; the
  // governance steps are admin/flag scoped. Explore is for everyone.
  const canSetup = isPlatformAdmin || canReadProviders
  const isAdmin = isPlatformAdmin || isOrgAdmin

  const counts: OnboardingCounts = data ?? {
    providerCount: 0, catalogItemCount: 0, workspaceCount: 0, hasOntology: false, viewCount: 0,
  }

  const tracks = useMemo<OnboardingTrack[]>(() => {
    const did = (id: string) => manual.includes(id)
    const out: (OnboardingTrack | null)[] = []

    if (canSetup) {
      out.push(makeTrack('setup', 'Set up the platform', 'Connect your data and give it meaning', 'setup', Boxes, [
        makeStep('connect-provider', 'Connect a provider', 'Link a data provider so we can read your metadata.', DatabaseZap, counts.providerCount > 0, { href: '/ingestion', guideSlug: 'admin-setup' }),
        makeStep('discover-assets', 'Discover assets', 'Register data sources from your connected providers.', Boxes, counts.catalogItemCount > 0, { href: '/ingestion', guideSlug: 'admin-setup' }),
        makeStep('create-workspace', 'Create a workspace', 'Group data sources into a workspace for your team.', Layers, counts.workspaceCount > 0, { href: '/workspaces', guideSlug: 'workspace-admin' }),
        makeStep('assign-ontology', 'Assign an ontology', 'Give a data source a semantic layer to model against.', Layers, counts.hasOntology, { href: '/schema', guideSlug: 'semantic-layer' }),
      ]))
    }

    out.push(makeTrack('explore', 'Explore your data', 'See how everything connects', 'explore', Compass, [
      makeStep('create-view', 'Create a view', 'Build your first curated view of the lineage graph.', PlusCircle, counts.viewCount > 0 || did('create-view'), { href: '/workspaces', guideSlug: 'creating-views' }),
      makeStep('trace-lineage', 'Trace lineage', 'Follow data upstream and downstream on the canvas.', GitBranch, did('trace-lineage'), { href: '/explorer', guideSlug: 'reading-lineage', manual: true }),
    ]))

    const govern: OnboardingStep[] = []
    if (isAdmin) {
      govern.push(makeStep('invite-team', 'Invite your team', 'Bring teammates in so they can explore alongside you.', Users, did('invite-team'), { href: '/admin/users', guideSlug: 'users-access', manual: true }))
      govern.push(makeStep('configure-access', 'Set up access & roles', 'Control who can see and change what, with groups and SSO.', ShieldCheck, did('configure-access'), { href: '/admin/groups', guideSlug: 'users-access', manual: true }))
    }
    if (versioningEnabled) {
      govern.push(makeStep('try-reviews', 'Review a change', 'Draft, review and merge changes like a pull request.', GitPullRequest, did('try-reviews'), { href: '/workspaces', guideSlug: 'versioning-change-control', manual: true }))
    }
    if (govern.length) {
      out.push(makeTrack('govern', 'Collaborate & govern', 'Bring your team in and manage change', 'govern', Users, govern))
    }

    return out.filter((t): t is OnboardingTrack => t !== null)
  }, [counts, manual, canSetup, isAdmin, versioningEnabled])

  const allSteps = tracks.flatMap((t) => t.steps)
  const completedCount = allSteps.filter((s) => s.done).length
  const total = allSteps.length

  return {
    tracks,
    completedCount,
    total,
    allDone: total > 0 && completedCount === total,
    isLoading: isPending,
  }
}
