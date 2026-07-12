/**
 * DataSourceOverviewPage — a routable home for ONE data source.
 *
 * The owner's insight used to be scattered: a row in Ingestion, a card in
 * Job History, and a transient workspace-scoped drawer. This page unifies
 * the picture around the catalog item (the Ingestion "Data Source"
 * identity), so an owner can deep-link to it and see the full profile in
 * one place. The profile itself lives in DataSourceProfile, shared with the
 * Ingestion drawer and the Workspaces Insights tab — this page is just the
 * full-page frame + back button around it.
 */
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { DataSourceProfile } from '@/components/insights/DataSourceProfile'

export function DataSourceOverviewPage() {
    const { catalogId = '' } = useParams()
    const navigate = useNavigate()
    useDocumentTitle('Data Source')

    return (
        <div className="absolute inset-0 overflow-y-auto">
            <div className="max-w-[1440px] mx-auto px-6 md:px-10 lg:px-12 py-8 animate-in fade-in duration-500">
                {/* Single-column profile constrained to a comfortable reading
                    column (the profile fills its container, so the drawers show
                    it full-width; the page centres it instead of stretching). */}
                <div className="max-w-3xl mx-auto">
                    <button
                        onClick={() => navigate('/ingestion?tab=assets')}
                        className="mb-6 inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-ink transition-colors"
                    >
                        <ArrowLeft className="w-3.5 h-3.5" /> Data Sources
                    </button>
                    <DataSourceProfile catalogId={catalogId} />
                </div>
            </div>
        </div>
    )
}
