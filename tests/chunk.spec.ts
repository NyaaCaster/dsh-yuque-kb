import { describe, expect, it } from 'vitest'
import { chunkMarkdown, DEFAULT_MAX_CHARS } from '../src/storage/chunk.ts'
import type { Chunk } from '../src/storage/chunk.ts'

/** Count code points (CJK-safe length). */
function codePointLength(text: string): number {
  return Array.from(text).length
}

describe('chunkMarkdown headings', () => {
  it('emits one heading chunk per ATX heading, followed by paragraph text', () => {
    const chunks = chunkMarkdown('# 标题一\n\n普通段落文本\n\n## 标题二\n\n第二段')
    expect(chunks).toEqual([
      { type: 'heading', text: '# 标题一' },
      { type: 'paragraph', text: '普通段落文本' },
      { type: 'heading', text: '## 标题二' },
      { type: 'paragraph', text: '第二段' },
    ])
  })

  it('recognizes all six ATX levels', () => {
    const chunks = chunkMarkdown('###### 六级标题')
    expect(chunks).toEqual([{ type: 'heading', text: '###### 六级标题' }])
  })

  it('treats a hash-prefixed non-heading line as a paragraph', () => {
    const chunks = chunkMarkdown('##not-a-heading')
    expect(chunks).toEqual([{ type: 'paragraph', text: '##not-a-heading' }])
  })
})

describe('chunkMarkdown paragraphs', () => {
  it('returns [] for empty or whitespace-only input', () => {
    expect(chunkMarkdown('')).toEqual([])
    expect(chunkMarkdown('   \n\t\n  ')).toEqual([])
  })

  it('splits long paragraphs at whitespace, each chunk within the ceiling', () => {
    const sentence = '这是一个很长的中文段落，'.repeat(50) // 12 * 50 = 600 chars
    const chunks = chunkMarkdown(sentence)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.type).toBe('paragraph')
      expect(codePointLength(chunk.text)).toBeLessThanOrEqual(DEFAULT_MAX_CHARS)
    }
    expect(chunks.map(chunk => chunk.text).join('')).toBe(sentence)
  })

  it('splits a hard-cut fallback when a single word exceeds the ceiling', () => {
    const word = 'x'.repeat(DEFAULT_MAX_CHARS + 50)
    const chunks = chunkMarkdown(word)
    expect(chunks.length).toBe(2)
    for (const chunk of chunks) {
      expect(codePointLength(chunk.text)).toBeLessThanOrEqual(DEFAULT_MAX_CHARS)
    }
    expect(chunks[0]?.text).toBe('x'.repeat(DEFAULT_MAX_CHARS))
    expect(chunks[1]?.text).toBe('x'.repeat(50))
  })

  it('honors a custom maxChars option', () => {
    const chunks = chunkMarkdown('一二三四五六七八九十', { maxChars: 6 })
    expect(chunks).toEqual([
      { type: 'paragraph', text: '一二三四五六' },
      { type: 'paragraph', text: '七八九十' },
    ])
  })

  it('keeps in-paragraph line breaks and skips blank-line separators', () => {
    const chunks = chunkMarkdown('第一行\n第二行\n\n第三行')
    expect(chunks).toEqual([
      { type: 'paragraph', text: '第一行\n第二行' },
      { type: 'paragraph', text: '第三行' },
    ])
  })

  it('drops setext underline / horizontal-rule lines from paragraph text', () => {
    const chunks = chunkMarkdown('上面的标题文字\n=====\n正文内容')
    expect(chunks).toEqual([
      { type: 'paragraph', text: '上面的标题文字' },
      { type: 'paragraph', text: '正文内容' },
    ])
  })
})

describe('chunkMarkdown code blocks', () => {
  it('keeps an over-long fenced code block as one atomic code chunk', () => {
    const code = '```ts\n' + 'const line = "abcdefgh";\n'.repeat(60) + '```'
    const chunks = chunkMarkdown(code)
    expect(chunks).toEqual([{ type: 'code', text: code }])
    expect(codePointLength(chunks[0]!.text)).toBeGreaterThan(DEFAULT_MAX_CHARS)
  })

  it('supports tilde fences and never splits code across chunks', () => {
    const code = '~~~\ncode line\n~~~'
    const chunks = chunkMarkdown(code)
    expect(chunks).toEqual([{ type: 'code', text: code }])
  })

  it('treats an unclosed fence as code to the end of input', () => {
    const chunks = chunkMarkdown('```python\nprint(1)\nprint(2)')
    expect(chunks).toEqual([{ type: 'code', text: '```python\nprint(1)\nprint(2)' }])
  })

  it('does not treat a shorter fence inside a block as the closer', () => {
    const chunks = chunkMarkdown('```\na\n``\nb\n```')
    expect(chunks).toEqual([{ type: 'code', text: '```\na\n``\nb\n```' }])
  })

  it('separates code from surrounding paragraphs', () => {
    const chunks = chunkMarkdown('前言\n\n```\nbody\n```\n\n后记')
    expect(chunks.map(chunk => chunk.type)).toEqual(['paragraph', 'code', 'paragraph'])
  })
})

describe('chunkMarkdown tables', () => {
  const table = [
    '| 名称 | 说明 |',
    '| --- | --- |',
    '| 语雀 | 知识库 |',
    '| 开放平台 | API |',
  ].join('\n')

  it('keeps a whole pipe-table region as one atomic table chunk', () => {
    const chunk = chunkMarkdown(table)
    expect(chunk).toEqual([{ type: 'table', text: table }])
  })

  it('keeps an over-long table together (atomic)', () => {
    const wide = '| col |\n' + ('| ' + 'z'.repeat(200) + ' |\n').repeat(10)
    const chunks = chunkMarkdown(wide)
    // Chunks normalize away the trailing document newline.
    expect(chunks).toEqual([{ type: 'table', text: wide.trimEnd() }])
    expect(codePointLength(chunks[0]!.text)).toBeGreaterThan(DEFAULT_MAX_CHARS)
  })

  it('splits two table regions separated by a blank line', () => {
    const two = `${table}\n\ntext between\n\n${table}`
    const chunks = chunkMarkdown(two)
    expect(chunks.map(chunk => chunk.type)).toEqual(['table', 'paragraph', 'table'])
  })

  it('does not treat an inline pipe-having line as a table row', () => {
    const chunks = chunkMarkdown('把 a | b 写进正文即可')
    expect(chunks).toEqual([{ type: 'paragraph', text: '把 a | b 写进正文即可' }])
  })
})

describe('chunkMarkdown mixed documents', () => {
  it('walks a realistic doc in order: heading → paragraph → code → table → paragraph', () => {
    const doc = [
      '# 使用指南',
      '',
      '本段落介绍基本用法。',
      '',
      '```sh',
      'npm install dsh-yuque-kb',
      '```',
      '',
      '| 参数 | 默认值 |',
      '| --- | --- |',
      '| limit | 8 |',
      '',
      '更多细节见下节。',
    ].join('\n')
    const chunks: Chunk[] = chunkMarkdown(doc)
    expect(chunks).toEqual([
      { type: 'heading', text: '# 使用指南' },
      { type: 'paragraph', text: '本段落介绍基本用法。' },
      { type: 'code', text: '```sh\nnpm install dsh-yuque-kb\n```' },
      { type: 'table', text: '| 参数 | 默认值 |\n| --- | --- |\n| limit | 8 |' },
      { type: 'paragraph', text: '更多细节见下节。' },
    ])
    expect(chunks.map(chunk => chunk.text).join('')).toContain('npm install dsh-yuque-kb')
  })
})