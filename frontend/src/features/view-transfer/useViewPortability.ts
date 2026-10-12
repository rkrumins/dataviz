import { useFeature } from '@/store/features'

/**
 * What this deployment offers of view versions, import and export. The whole feature is a preview
 * behind one switch (Admin → Features); Export views and Import views then decide the directions,
 * and mean nothing while the preview is off.
 */
export function useViewPortability() {
  const enabled = useFeature('viewPortabilityEnabled')
  const exportEnabled = useFeature('viewExportEnabled')
  const importEnabled = useFeature('viewImportEnabled')
  return { versions: enabled, canExport: enabled && exportEnabled, canImport: enabled && importEnabled }
}
