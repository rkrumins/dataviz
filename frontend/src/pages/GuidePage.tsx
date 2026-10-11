import { Sparkles, BookOpen } from 'lucide-react'
import { GuideSidebar } from '@/components/guide/GuideSidebar'
import { ReaderLayout } from '@/components/docs/reading/ReaderLayout'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useBrand } from '@/store/branding'

export function GuidePage() {
  const { appName } = useBrand()
  useDocumentTitle('User Guide')
  return (
    <ReaderLayout
      area="guide"
      title={`${appName} User Guide`}
      logo={
        <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow shadow-indigo-500/20 shrink-0">
          <Sparkles className="w-3.5 h-3.5 text-white" />
        </div>
      }
      crossLink={{ to: '/docs', label: 'Engineer docs', title: 'Engineer documentation', icon: BookOpen }}
      sidebar={<GuideSidebar />}
    />
  )
}
