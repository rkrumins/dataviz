import type { Components } from 'react-markdown'
import { Link as RouterLink } from 'react-router-dom'
import { markdownComponents } from '@/components/docs/MarkdownComponents'

// Reuse the docs renderers (headings, code, Mermaid, tables, images) but route
// internal app links (/guide/*, /docs/*) through the SPA router instead of
// opening them as external links in a new tab.
export const guideMarkdownComponents: Components = {
  ...markdownComponents,
  a: ({ href, children, ...props }) => {
    if (!href) return <a {...props}>{children}</a>

    if (href.startsWith('/guide/') || href.startsWith('/docs')) {
      return (
        <RouterLink to={href} {...props}>
          {children}
        </RouterLink>
      )
    }

    if (href.startsWith('#')) {
      return <a href={href} {...props}>{children}</a>
    }

    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    )
  },
}
