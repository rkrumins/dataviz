/**
 * ApproveForEveryone — in the editor's header, for a published semantic layer a workspace owns
 * (one that moved there with a graph from the Playground): an org editor makes it an
 * organization-wide layer, offered everywhere — including in the Playground, as approved.
 */
import { useState } from 'react'
import { BadgeCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useAppNotifications } from '@/components/ui/notifications'
import { ontologyDefinitionService, type OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { useOntologyMutations } from '../hooks/useOntologyMutations'
import { useSemanticLayerAccess } from '../lib/useSemanticLayerAccess'

export function ApproveForEveryone({ ontology }: { ontology: OntologyDefinitionResponse }) {
  // The org's own rules decide, not this layer's: approving is an org editor's step.
  const org = useSemanticLayerAccess()
  const { invalidateAll } = useOntologyMutations()
  const { notify } = useAppNotifications()
  const [busy, setBusy] = useState(false)
  if (!ontology.ownerWorkspaceId || !ontology.isPublished || ontology.deletedAt || !org.canPublish) return null

  const approve = async () => {
    setBusy(true)
    try {
      await ontologyDefinitionService.approve(ontology.id)
      invalidateAll()
      notify('success', `“${ontology.name}” is approved for everyone.`)
    } catch (e) {
      notify('error', e instanceof Error && e.message ? e.message : 'Couldn’t approve it. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button size="sm" variant="secondary" leftIcon={BadgeCheck} loading={busy} onClick={approve}
      title="Make it an organization-wide semantic layer, offered everywhere">
      Approve for everyone
    </Button>
  )
}
