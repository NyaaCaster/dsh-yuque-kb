/**
 * Markdown structure-aware chunking for the FTS5 index.
 *
 * Documents are split into small indexable units before they enter the
 * full-text table. Chunk boundaries follow markdown structure (headings,
 * paragraphs, fenced code blocks, pipe tables) instead of bare character
 * counts, so a later `kb_search` hit maps back to a readable unit and
 * `kb_read` can page blocks without cutting mid-structure.
 *
 * Guarantees:
 * - Paragraph chunks never exceed `maxChars` (split at the last whitespace
 *   inside the window when possible; hard-split otherwise).
 * - Code blocks and tables are atomic: a single fence or a single pipe-table
 *   region stays one chunk even when longer than `maxChars`, so code never
 *   gets cut mid-line and a query can match a whole table row-set.
 * - Headings are one chunk each.
 *
 * Pure function: no I/O, no state, deterministic for the same input.
 */

/** Soft ceiling of one paragraph chunk in code points. */
export const DEFAULT_MAX_CHARS = 512

/** Structural chunk categories, mirroring the `blocks` model of `kb_read`. */
export type ChunkType = 'heading' | 'paragraph' | 'code' | 'table'

/** One indexable document fragment. */
export interface Chunk {
  /** Structural role of this fragment. */
  type: ChunkType
  /** Fragment text (code points ≤ `maxChars` for paragraphs; atomic otherwise). */
  text: string
}

/** Chunking options. */
export interface ChunkOptions {
  /**
   * Maximum paragraph chunk length in code points; longer paragraphs are
   * split at whitespace boundaries. Structural blocks (code/table/heading)
   * ignore this ceiling. Defaults to {@link DEFAULT_MAX_CHARS}.
   */
  maxChars?: number
}

const ATX_HEADING_RE = /^#{1,6}\s+\S/
const FENCE_RE = /^\s*(`{3,}|~{3,})/
const CLOSING_FENCE_RE = /^\s*(`{3,}|~{3,})\s*$/
const SETEXT_LINE_RE = /^\s*(=+|-+)\s*$/

/** Whether a trimmed line looks like a pipe-table row (leading or trailing `|`). */
function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return false
  return trimmed.startsWith('|') || trimmed.endsWith('|')
}

/** Whether a line closes an open fence (`marker` is the opening ``` or ~~~ run). */
function isClosingFence(line: string, marker: string): boolean {
  const match = CLOSING_FENCE_RE.exec(line.trimEnd())
  if (match === null || match[1] === undefined) return false
  return match[1].startsWith(marker[0] ?? marker) && match[1].length >= marker.length
}

/**
 * Split long paragraph text into bounded chunks, preferring the last
 * whitespace inside the window and hard-cutting otherwise. Operates on code
 * points so CJK text is measured by character, not UTF-16 unit.
 * @param text - paragraph text.
 * @param maxChars - chunk ceiling in code points.
 * @returns bounded paragraph chunks, whitespace-trimmed.
 */
function splitLongParagraph(text: string, maxChars: number): string[] {
  const characters = Array.from(text)
  const chunks: string[] = []
  let start = 0
  while (start < characters.length) {
    const windowEnd = Math.min(characters.length, start + maxChars)
    let cut = -1
    if (windowEnd < characters.length) {
      for (let index = windowEnd; index > start + Math.floor(maxChars / 2); index -= 1) {
        if (/\s/u.test(characters[index - 1] ?? '')) {
          cut = index
          break
        }
      }
    }
    const end = cut === -1 ? windowEnd : cut
    const segment = characters.slice(start, end).join('').trim()
    if (segment !== '') chunks.push(segment)
    start = end
  }
  return chunks
}

/**
 * Chunk one markdown document into structural fragments.
 * @param markdown - full document text (UTF-8 decoded, raw markdown).
 * @param options - chunking options.
 * @returns ordered chunk list; `[]` for empty or whitespace-only input.
 */
export function chunkMarkdown(markdown: string, options?: ChunkOptions): Chunk[] {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS
  const chunks: Chunk[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const text = paragraph.join('\n')
    paragraph = []
    for (const segment of splitLongParagraph(text, maxChars)) {
      chunks.push({ type: 'paragraph', text: segment })
    }
  }

  const lines = markdown.split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''

    // Fenced code block: atomic, captured with its fences.
    const fence = FENCE_RE.exec(line)
    if (fence !== null && fence[1] !== undefined) {
      flushParagraph()
      const start = index
      index += 1
      while (index < lines.length) {
        if (isClosingFence(lines[index] ?? '', fence[1])) {
          index += 1
          break
        }
        index += 1
      }
      chunks.push({ type: 'code', text: lines.slice(start, index).join('\n') })
      continue
    }

    // Pipe table region: consecutive table rows stay one atomic chunk.
    if (isTableLine(line)) {
      flushParagraph()
      const start = index
      index += 1
      while (index < lines.length && isTableLine(lines[index] ?? '')) {
        index += 1
      }
      chunks.push({ type: 'table', text: lines.slice(start, index).join('\n') })
      continue
    }

    // ATX heading: one chunk per heading line.
    if (ATX_HEADING_RE.test(line)) {
      flushParagraph()
      chunks.push({ type: 'heading', text: line })
      index += 1
      continue
    }

    // Setext underline / horizontal rule: terminates the pending paragraph
    // (the preceding lines were heading text) and contributes no content.
    if (SETEXT_LINE_RE.test(line)) {
      flushParagraph()
      index += 1
      continue
    }

    // Blank line: paragraph boundary.
    if (line.trim() === '') {
      flushParagraph()
      index += 1
      continue
    }

    paragraph.push(line)
    index += 1
  }
  flushParagraph()
  return chunks
}