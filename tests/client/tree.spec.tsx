// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KbTree } from '../../src/client/tree/KbTree.tsx'
import type { RepoNode } from '../../src/client/types.ts'
import { zh } from '../../src/client/locales.ts'

const t = (key: keyof typeof zh, params?: Record<string, string | number>): string => {
  let text = zh[key] ?? ''

  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value))
  }
  return text
}

const repo: RepoNode = {
  namespace: 'nyaa-rgeis/docs',
  name: '手册',
  type: 'Book',
  enabled: true,
  updatedAt: 1724000000000,
  itemsCount: 2,
  docs: [
    { docId: 'd1', slug: 'intro', title: '部署手册', path: '运维/部署手册', enabled: true, updatedAt: 1724000000000, synced: true },
    { docId: 'd2', slug: 'api', title: 'API 参考', path: 'API/参考', enabled: false, updatedAt: 1724000000000, synced: false },
  ],
}

describe('KbTree', () => {
  it('renders repos with doc groups and toggle states when expanded', () => {
    const onToggle = vi.fn()
    render(
      <KbTree
        repos={[repo]}
        
        expanded={{ 'repo:nyaa-rgeis/docs': true }}
        expandAll={false}
        filter=""
        t={t}
        onToggleExpand={() => {}}
        onToggle={onToggle}
      />,
    )
    expect(screen.getByText('手册')).toBeTruthy()
    expect(screen.getByText('部署手册')).toBeTruthy()
    expect(screen.getByText('API 参考')).toBeTruthy()
    expect(screen.getByText('未同步')).toBeTruthy()
    // Two switches: repo + two docs (repo enabled, d1 enabled, d2 disabled).
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(3)
    expect(switches[0]?.getAttribute('aria-checked')).toBe('true')
    expect(switches[2]?.getAttribute('aria-checked')).toBe('false')
  })

  it('reports the expand gesture for a collapsed repo', () => {
    const onToggleExpand = vi.fn()
    render(
      <KbTree
        repos={[repo]}
        
        expanded={{}}
        expandAll={false}
        filter=""
        t={t}
        onToggleExpand={onToggleExpand}
        onToggle={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('▸'))
    expect(onToggleExpand).toHaveBeenCalledWith('repo:nyaa-rgeis/docs')
  })

  it('filters docs by name and keeps matches visible', () => {
    const { container } = render(
      <KbTree
        repos={[repo]}
        
        expanded={{}}
        expandAll={false}
        filter="API"
        t={t}
        onToggleExpand={() => {}}
        onToggle={() => {}}
      />,
    )
    // Filtering forces the repo visible; only the API doc row remains.
    expect(screen.getByText('API 参考')).toBeTruthy()
    const docTitles = [...container.querySelectorAll('li')]
      .map(node => node.textContent ?? '')
      .filter(text => text.includes('部署手册'))
    expect(docTitles).toHaveLength(0)
  })

  it('calls onToggle with the entity id and target state', () => {
    const onToggle = vi.fn()
    render(
      <KbTree
        repos={[repo]}
        
        expanded={{ 'repo:nyaa-rgeis/docs': true }}
        expandAll={false}
        filter=""
        t={t}
        onToggleExpand={() => {}}
        onToggle={onToggle}
      />,
    )
    const switches = screen.getAllByRole('switch')
    // Repo switch (enabled): flip to disabled.
    fireEvent.click(switches[0]!)
    expect(onToggle).toHaveBeenCalledWith('repo', 'nyaa-rgeis/docs', false)
    // Doc switch (d2, disabled): flip to enabled.
    fireEvent.click(switches[2]!)
    expect(onToggle).toHaveBeenCalledWith('doc', 'd2', true)
  })
})