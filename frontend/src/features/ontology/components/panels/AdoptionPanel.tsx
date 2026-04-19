/**
 * AdoptionPanel — unified Usage + Version History view.
 *
 * Top section: workspace/data source assignments (from UsagePanel)
 * Bottom section: collapsible version history timeline (from VersionHistoryPanel)
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight, Clock } from 'lucide-react'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse } from '@/services/workspaceService'

import { UsagePanel } from './UsagePanel'
import { VersionHistoryPanel } from './VersionHistoryPanel'
import { EducationalCallout } from '../EducationalCallout'

interface AdoptionPanelProps {
  ontology: OntologyDefinitionResponse
  workspaces: WorkspaceResponse[]
  ontologies: OntologyDefinitionResponse[]
}

export function AdoptionPanel({ ontology, workspaces, ontologies }: AdoptionPanelProps) {
  const [historyOpen, setHistoryOpen] = useState(true)

  return (
    <div className="space-y-8">
      <EducationalCallout
        id="edu-assignment"
        title="Ontology Assignments"
        description="Assigning an ontology to a data source tells the system to interpret that graph using these type definitions. Views, visualizations, and semantic features are all driven by the assigned ontology. Data sources without one will have limited functionality."
        variant="info"
      />

      {/* Usage section — rendered directly */}
      <UsagePanel ontology={ontology} workspaces={workspaces} ontologies={ontologies} />

      {/* Version History — collapsible section */}
      <div className="border-t border-glass-border/60 pt-6">
        <button
          onClick={() => setHistoryOpen(!historyOpen)}
          className="flex items-center gap-2 text-sm font-semibold text-ink-secondary hover:text-ink transition-colors group mb-4"
        >
          {historyOpen
            ? <ChevronDown className="w-4 h-4 text-ink-muted" />
            : <ChevronRight className="w-4 h-4 text-ink-muted" />
          }
          <Clock className="w-4 h-4 text-ink-muted group-hover:text-ink transition-colors" />
          Version History
        </button>

        {historyOpen && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-200">
            <VersionHistoryPanel ontology={ontology} />
          </div>
        )}
      </div>
    </div>
  )
}
