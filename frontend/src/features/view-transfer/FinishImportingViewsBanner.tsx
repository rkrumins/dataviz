/**
 * FinishImportingViewsBanner — on a data source made from a view package, while none of the
 * package's views are here yet and its upload is still kept: the views are one click away, read
 * from that upload (no file to choose again).
 *
 * Copying a package's data into a new data source is a job; whoever started it may close the
 * wizard before its views come in. The data source remembers where it came from
 * (`extraConfig.origin`, kind `viewPackage`, with the upload), so this is where they finish. Only
 * the upload's owner can read it (anyone else gets a 404), so only they see this. Self-contained,
 * like VocabAlignmentWarning, so it slots into the data-source panel with one line.
 */
import { useContext } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileUp, Layers } from 'lucide-react'
import { ViewEditorContext } from '@/components/layout/viewEditorContext'
import { workspaceService, type DataSourceResponse } from '@/services/workspaceService'
import { getPackageUpload } from '@/services/viewTransferApiService'
import { useViewPortability } from './useViewPortability'

/** Where a data source came from, when a view package made it. */
function packageOrigin(ds: DataSourceResponse | undefined): { uploadId: string } | null {
  // The workspace list leaves `extraConfig` out; the data-source list carries it.
  const origin = (ds as { extraConfig?: { origin?: { kind?: string; uploadId?: string } } | null } | undefined)
    ?.extraConfig?.origin
  return origin?.kind === 'viewPackage' && origin.uploadId ? { uploadId: origin.uploadId } : null
}

export function FinishImportingViewsBanner({ wsId, dataSourceId, viewCount }: {
  wsId: string
  dataSourceId: string
  /** Views built on the data source: once one is, there is nothing left to finish here. */
  viewCount: number
}) {
  const { canImport } = useViewPortability()
  const viewEditor = useContext(ViewEditorContext)
  const sources = useQuery({
    queryKey: ['workspaces', wsId, 'data-sources'],
    queryFn: () => workspaceService.listDataSources(wsId),
    enabled: canImport && viewEditor !== null && viewCount === 0,
    staleTime: 60_000,
  })
  const origin = packageOrigin(sources.data?.find(d => d.id === dataSourceId))
  // Kept: checked, and not run out of time (an upload is kept for a day).
  const kept = useQuery({
    queryKey: ['view-package-upload', origin?.uploadId],
    queryFn: async () => {
      const upload = await getPackageUpload(origin!.uploadId)
      return upload.status === 'ready' && Date.parse(upload.expiresAt) > Date.now()
    },
    enabled: !!origin && viewCount === 0,
    retry: false,
    staleTime: 60_000,
  })
  if (!origin || !kept.data || !viewEditor || viewCount > 0) return null

  return (
    <div className="mx-6 mt-3 flex items-start gap-3 rounded-xl border border-indigo-500/20 bg-indigo-500/[0.06] px-4 py-3">
      <Layers className="w-4 h-4 text-indigo-500 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">Its views haven’t been imported yet</p>
        <p className="text-[11px] text-ink-muted mt-0.5">
          This data source was copied from a view package, which is still kept: bring its views in from there, once the copy is done.
        </p>
      </div>
      <button
        type="button"
        onClick={() => viewEditor.openViewEditor(undefined, {
          journey: 'import', importUploadId: origin.uploadId, workspaceId: wsId, dataSourceId,
        })}
        className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-indigo-500 hover:bg-indigo-600"
      >
        <FileUp className="w-3.5 h-3.5" /> Finish importing views
      </button>
    </div>
  )
}
