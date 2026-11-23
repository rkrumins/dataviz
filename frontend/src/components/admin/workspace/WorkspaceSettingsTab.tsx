/**
 * WorkspaceSettingsTab — how this workspace behaves, in one place.
 *
 * These used to sit above the data-source grid for everyone who opened the
 * workspace — node-identity defaults (`urn` / `name` inheritance), drafts whose
 * owner left — so a reader came for their
 * views and met configuration first. They are the business of the people who
 * run the workspace, so they live here, each with a sentence saying what it
 * decides; each block still decides for itself who may change it. How drafts and
 * reviews work is set on the Versioned graphs tab, with the rest of its settings.
 */
import type { ComponentType, ReactNode } from 'react'
import { Fingerprint, GitPullRequestArrow } from 'lucide-react'
import { WorkspaceNodeIdentityDefaults } from './WorkspaceNodeIdentityDefaults'
import { DraftsWhoseOwnerLeft } from './DraftsWhoseOwnerLeft'

export function WorkspaceSettingsTab({
    wsId, identityProperty, nameProperty, canEditIdentity, versioningEnabled, onOpenVersionedGraphs, onSaved,
}: {
    wsId: string
    identityProperty?: string | null
    nameProperty?: string | null
    canEditIdentity: boolean
    versioningEnabled: boolean
    /** Opens the Versioned graphs tab, where drafts and reviews are set. */
    onOpenVersionedGraphs?: () => void
    onSaved: () => void
}) {
    return (
        <div className="py-5 space-y-6 max-w-4xl">
            <SettingsGroup
                icon={Fingerprint}
                title="How things are recognised"
                description="Which property tells one entity from another, and which is shown as its name — for the sources this workspace onboards itself. A source can still set its own."
            >
                <WorkspaceNodeIdentityDefaults
                    wsId={wsId}
                    identityProperty={identityProperty}
                    nameProperty={nameProperty}
                    canEdit={canEditIdentity}
                    onSaved={onSaved}
                />
            </SettingsGroup>

            {versioningEnabled && (
                <SettingsGroup
                    icon={GitPullRequestArrow}
                    title="Drafts and reviews"
                    description="Drafts left behind by people who have gone, to hand on."
                >
                    <p className="text-xs text-ink-muted leading-relaxed">
                        Whether new drafts start private or public, and who may approve and merge a review, is set on{' '}
                        {onOpenVersionedGraphs
                            ? <button type="button" onClick={onOpenVersionedGraphs} className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">Versioned graphs</button>
                            : 'Versioned graphs'}.
                    </p>
                    <DraftsWhoseOwnerLeft wsId={wsId} />
                </SettingsGroup>
            )}
        </div>
    )
}

function SettingsGroup({ icon: Icon, title, description, children }: {
    icon: ComponentType<{ className?: string }>
    title: string
    description: string
    children: ReactNode
}) {
    return (
        <section aria-labelledby={`settings-${title}`} className="grid gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
            <div>
                <h2 id={`settings-${title}`} className="flex items-center gap-2 text-sm font-bold text-ink">
                    <Icon className="w-4 h-4 text-ink-muted" aria-hidden /> {title}
                </h2>
                <p className="mt-1 text-xs text-ink-muted leading-relaxed">{description}</p>
            </div>
            <div className="min-w-0 space-y-3">{children}</div>
        </section>
    )
}
