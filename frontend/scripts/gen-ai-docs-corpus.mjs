#!/usr/bin/env node
/**
 * Build the AI service's product-knowledge corpus from the in-app
 * Documentation and User Guide.
 *
 * The Help persona answers from these pages and links each citation to the
 * exact section, so a section's anchor here must be the one the in-app
 * reader renders. That is why this runs in Node with the same
 * `github-slugger` pass as `src/components/docs/reading/headings.ts`
 * (`walkMarkdown` / `splitSections`): every h2 and h3 becomes one section,
 * duplicate headings get the same `-1` suffixes, fenced code is skipped when
 * finding headings.
 *
 * Pages come from `docsConfig.ts` and `guideConfig.ts` (parsed the way
 * `gen-doc-meta.mjs` parses them), FAQs from their `faqEntries` /
 * `guideFaqs`. `{brand}` tokens are kept: the AI service fills them in from
 * the deployment's branding when it answers.
 *
 * Output: backend/ai_service/knowledge/docs_corpus.generated.json — not
 * committed (it is as large as the docs themselves): `backend/Dockerfile.ai`
 * runs this script when it builds the AI service's image, and
 * `npm run gen:ai-docs-corpus` writes it for a service run from source.
 * The release history (`changelog`) is left out: it is sectioned by Added /
 * Fixed rather than by subject, and the release notes cover what is new.
 * `--check` exits 1 when the file is missing or out of date.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import GithubSlugger, { slug as githubSlug } from 'github-slugger'

const here = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(here, '..')
const REPO = resolve(FRONTEND, '..')
const OUT = resolve(
  process.env.AI_DOCS_CORPUS_OUT || resolve(REPO, 'backend/ai_service/knowledge/docs_corpus.generated.json'),
)
const SKIP = new Set(['changelog'])

/** A JS string literal's value, from its opening quote; returns [value, endIndex]. */
function readString(src, i) {
  const quote = src[i]
  let out = ''
  let j = i + 1
  while (j < src.length) {
    const ch = src[j]
    if (ch === '\\') {
      const next = src[j + 1]
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      j += 2
      continue
    }
    if (ch === quote) return [out, j + 1]
    out += ch
    j += 1
  }
  return [out, j]
}

/** The (possibly `+`-concatenated) string value after `key:` starting at index i. */
function valueAfter(src, key, from, limit = 4000) {
  const re = new RegExp(`\\b${key}:\\s*`, 'g')
  re.lastIndex = from
  const m = re.exec(src)
  if (!m || m.index - from > limit) return [null, from]
  let i = m.index + m[0].length
  let value = ''
  for (;;) {
    while (/\s/.test(src[i])) i += 1
    if (!/['"`]/.test(src[i])) break
    const [part, end] = readString(src, i)
    value += part
    i = end
    let k = i
    while (/\s/.test(src[k])) k += 1
    if (src[k] === '+') { i = k + 1; continue }
    break
  }
  return [value, i]
}

function parseEntries(configPath, area) {
  const src = readFileSync(configPath, 'utf8')
  const entries = []
  const re = /slug:\s*'([^']+)'/g
  let m
  while ((m = re.exec(src))) {
    const start = m.index
    const window = src.slice(start, start + 1500)
    const imp = /import\('@(docs|root)\/([^?']+\.md)/.exec(window)
    if (!imp) continue
    const [title] = valueAfter(src, 'title', start, 600)
    const [section] = valueAfter(src, 'section', start, 300)
    const rel = imp[1] === 'docs' ? `docs/${imp[2]}` : imp[2]
    entries.push({ area, slug: m[1], title: title || m[1], section: section || '', path: rel })
  }
  return entries
}

function parseFaqs(configPath, exportName, area) {
  const src = readFileSync(configPath, 'utf8')
  const start = src.indexOf(`export const ${exportName}`)
  if (start < 0) return []
  const end = src.indexOf('\n]', start)
  const body = src.slice(start, end)
  const faqs = []
  const re = /question:\s*/g
  let m
  while ((m = re.exec(body))) {
    const [question, after] = valueAfter(body, 'question', m.index, 10)
    const [answer] = valueAfter(body, 'answer', after, 200)
    const [category] = valueAfter(body, 'category', Math.max(0, body.lastIndexOf('{', m.index)), 200)
    if (question && answer) faqs.push({ area, question, answer, category: category || '' })
  }
  return faqs
}

function headingText(raw) {
  return raw.replace(/`/g, '').replace(/\*\*?/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
}

/** Plain text for retrieval: links to their labels, emphasis and table pipes gone. */
function plain(md) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function splitSections(md) {
  const slugger = new GithubSlugger()
  const sections = []
  let current = { anchor: '', heading: '', prose: [], code: [] }
  let inFence = false
  let first = true
  const close = () => {
    const text = plain(current.prose.join('\n'))
    const code = current.code.join('\n').trim()
    if (!current.heading && !text && !code) return
    sections.push({
      anchor: current.anchor, heading: current.heading,
      text: code ? `${text}\n\n${code.slice(0, 800)}`.trim() : text,
    })
  }
  for (const raw of md.split('\n')) {
    const fence = /^\s*```/.test(raw)
    if (fence) { inFence = !inFence; continue }
    if (inFence) { current.code.push(raw); continue }
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(raw)
    if (!h) { current.prose.push(raw); continue }
    const text = headingText(h[2])
    const id = slugger.slug(text)
    const level = h[1].length
    if (level === 1 && first && sections.length === 0) { current.heading = text; first = false; continue }
    if (level === 2 || level === 3) {
      close()
      current = { anchor: id, heading: text, prose: [], code: [] }
      continue
    }
    current.prose.push(text)
  }
  close()
  return sections
}

function build() {
  const pages = [
    ...parseEntries(resolve(FRONTEND, 'src/components/docs/docsConfig.ts'), 'docs'),
    ...parseEntries(resolve(FRONTEND, 'src/components/guide/guideConfig.ts'), 'guide'),
  ]
  const entries = []
  for (const page of pages) {
    if (SKIP.has(page.slug)) continue
    const file = resolve(REPO, page.path)
    if (!existsSync(file)) continue
    const md = readFileSync(file, 'utf8')
    const sections = splitSections(md)
    const base = page.area === 'docs' ? `/docs/${page.slug}` : `/guide/${page.slug}`
    entries.push({
      area: page.area, slug: page.slug, title: page.title, section: page.section,
      path: page.path, href: base,
      sections: sections.map((s) => ({
        anchor: s.anchor, heading: s.heading || page.title,
        href: s.anchor ? `${base}#${s.anchor}` : base, text: s.text,
      })),
    })
  }
  const faqs = [
    ...parseFaqs(resolve(FRONTEND, 'src/components/docs/docsConfig.ts'), 'faqEntries', 'docs'),
    ...parseFaqs(resolve(FRONTEND, 'src/components/guide/guideConfig.ts'), 'guideFaqs', 'guide'),
  ].map((f) => {
    const anchor = `faq-${githubSlug(f.question.replace(/\{brand(Short)?\}/g, 'brand'))}`
    return {
      area: f.area, question: f.question, answer: f.answer, category: f.category,
      href: f.area === 'docs' ? `/docs/faq#${anchor}` : `/guide#${anchor}`,
    }
  })
  entries.sort((a, b) => (a.area + a.slug).localeCompare(b.area + b.slug))
  return { version: 1, entries, faqs }
}

const corpus = `${JSON.stringify(build())}\n`
if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (current !== corpus) {
    console.error('The AI docs corpus is out of date. Run: npm run gen:ai-docs-corpus')
    process.exit(1)
  }
  console.log('AI docs corpus is up to date.')
} else {
  writeFileSync(OUT, corpus)
  console.log(`Wrote ${OUT}`)
}
