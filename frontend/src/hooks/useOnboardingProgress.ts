/**
 * useOnboardingProgress — the single source of truth for the "Getting started"
 * checklist.
 *
 * Derives each step's done-state from live app data (the same services the
 * admin OnboardingProgress bar reads: providers, catalog items, workspaces,
 * and per-datasource ontology assignment), plus the views count and the
 * product-tour completion flag. Where a step isn't purely state-derived
 * (``create-view`` before the views API can confirm one), it falls back to the
 * manually-recorded onboarding step in preferences.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { providerService } from '@/services/providerService'
import { catalogService } from '@/services/catalogService'
import { workspaceService } from '@/services/workspaceService'
import { listViews } from '@/services/viewApiService'
import { usePreferencesStore } from '@/store/preferences'

/** The product tour the hub offers (as a persistent action, not a checklist step). */
export const GETTING_STARTED_TOUR = 'getting-started'

export interface OnboardingStep {
  id: string
  label: string
  description: string
  done: boolean
  /** In-SPA route the CTA navigates to. Absent for action-only steps (tour). */
  href?: string
  /** Guide slug for the step's contextual DocsLink. */
  guideSlug?: string
}

export interface OnboardingProgressResult {
  steps: OnboardingStep[]
  completedCount: number
  total: number
  allDone: boolean
  /** True until the first counts fetch settles — lets the card avoid a "0 of N" flash. */
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
 * Fetch the four count sources in parallel. Best-effort: a rejected read
 * (e.g. a non-admin who can't list providers/catalog) counts as zero rather
 * than failing the whole checklist, mirroring IngestionPage's allSettled load.
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
    hasOntology: workspaceList.some((ws) =>
      ws.dataSources?.some((ds) => !!ds.ontologyId),
    ),
    viewCount: views.status === 'fulfilled' ? views.value.total : 0,
  }
}

export function useOnboardingProgress(): OnboardingProgressResult {
  const { data, isPending } = useQuery({
    queryKey: ['onboarding-progress'],
    queryFn: fetchOnboardingCounts,
    staleTime: 30_000,
  })

  // Reactive store read — a manually-recorded step ticks off without a refetch.
  const completedManualSteps = usePreferencesStore((s) => s.onboardingCompletedSteps)

  const counts: OnboardingCounts = data ?? {
    providerCount: 0,
    catalogItemCount: 0,
    workspaceCount: 0,
    hasOntology: false,
    viewCount: 0,
  }

  const steps = useMemo<OnboardingStep[]>(() => [
    {
      id: 'connect-provider',
      label: 'Connect a provider',
      description: 'Link a data provider so we can start reading your metadata.',
      done: counts.providerCount > 0,
      href: '/ingestion',
      guideSlug: 'admin-setup',
    },
    {
      id: 'discover-assets',
      label: 'Discover assets',
      description: 'Register data sources from your connected providers.',
      done: counts.catalogItemCount > 0,
      href: '/ingestion',
      guideSlug: 'admin-setup',
    },
    {
      id: 'create-workspace',
      label: 'Create a workspace',
      description: 'Group data sources into a workspace for your team.',
      done: counts.workspaceCount > 0,
      href: '/workspaces',
      guideSlug: 'workspace-admin',
    },
    {
      id: 'assign-ontology',
      label: 'Assign an ontology',
      description: 'Give a workspace data source a semantic layer to model against.',
      done: counts.hasOntology,
      href: '/schema',
      guideSlug: 'semantic-layer',
    },
    {
      id: 'create-view',
      label: 'Create a view',
      description: 'Build your first curated view of the lineage graph.',
      done: counts.viewCount > 0 || completedManualSteps.includes('create-view'),
      href: '/workspaces',
      guideSlug: 'creating-views',
    },
  ], [counts, completedManualSteps])

  const completedCount = steps.filter((s) => s.done).length
  const total = steps.length

  return {
    steps,
    completedCount,
    total,
    allDone: completedCount === total,
    isLoading: isPending,
  }
}
