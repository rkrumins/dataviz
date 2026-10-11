import { BookOpen, Sparkles } from 'lucide-react'
import { DocsSidebar } from '@/components/docs/DocsSidebar'
import { ReaderLayout } from '@/components/docs/reading/ReaderLayout'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useBrand } from '@/store/branding'

export function DocsPage() {
  const { appName } = useBrand()
  useDocumentTitle('Docs')
  return (
    <ReaderLayout
      area="docs"
      title={`${appName} Docs`}
      logo={<BookOpen className="w-4 h-4 text-accent-lineage shrink-0" />}
      crossLink={{ to: '/guide', label: 'User guide', title: 'Business user guide', icon: Sparkles }}
      sidebar={<DocsSidebar />}
    />
  )
}
