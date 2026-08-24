/**
 * KbTree — the repo → group → doc tree with per-repo/per-doc enable toggles.
 * Pure presentation: all data and callbacks arrive through props; toggles are
 * optimistic in the parent and the rendered state follows the payload.
 */
import { useMemo } from 'react'
import type { DocNode, RepoNode } from '../types.ts'
import type { YuqueKbKey } from '../locales.ts'
import css from './KbTree.module.css'

/** One subtree row key: repo namespace or doc id. */
export type TreeKey = `repo:${string}` | `doc:${string}`

export interface KbTreeProps {
  repos: RepoNode[]
  expanded: Record<string, boolean>
  filter: string
  t: (key: keyof YuqueKbKey, params?: Record<string, string | number>) => string
  onToggleExpand: (key: string) => void
  onToggle: (kind: 'repo' | 'doc', id: string, enabled: boolean) => void
  /** Expand every repo (used by the toolbar). */
  expandAll: boolean
}

/** Group docs of one repo by the first path segment ("运维/部署" → "运维"). */
function groupDocs(docs: readonly DocNode[]): Array<{ group: string; docs: DocNode[] }> {
  const groups = new Map<string, DocNode[]>()
  for (const doc of docs) {
    const group = doc.path.includes('/') ? doc.path.split('/')[0] ?? '—' : '—'
    const list = groups.get(group)
    if (list === undefined) groups.set(group, [doc])
    else list.push(doc)
  }
  const result = [...groups.entries()]
    .map(([group, list]) => ({ group, docs: list }))
    .sort((a, b) => a.group.localeCompare(b.group, 'zh-CN'))
  return result
}

function RepoRow(props: {
  repo: RepoNode
  expanded: boolean
  filterActive: boolean
  matchesFilter: (text: string) => boolean
  t: KbTreeProps['t']
  onToggleExpand: (key: string) => void
  onToggle: KbTreeProps['onToggle']
}): React.JSX.Element {
  const { repo, expanded, filterActive, matchesFilter, t, onToggleExpand, onToggle } = props
  const visibleDocs = repo.docs.filter(doc => !filterActive || matchesFilter(doc.title) || matchesFilter(doc.path))
  const groups = groupDocs(visibleDocs)
  const showDocs = expanded || filterActive
  return (
    <li className={css.repo}>
      <div className={css.repoRow}>
        <button
          type="button"
          className={css.chevron}
          aria-expanded={showDocs}
          onClick={() => onToggleExpand(`repo:${repo.namespace}`)}
        >
          {showDocs ? '▾' : '▸'}
        </button>
        <span className={css.repoName} title={repo.namespace}>{repo.name}</span>
        <span className={css.repoMeta}>
          {t('docsCount', { n: visibleDocs.length })}
          {repo.docs.some(doc => !doc.synced)
            ? <span className={css.newBadge}>{t('newBadge')}</span>
            : null}
        </span>
        <Toggle
          checked={repo.enabled}
          label={t(repo.enabled ? 'enabledToggleOn' : 'enabledToggleOff')}
          onChange={(enabled) => onToggle('repo', repo.namespace, enabled)}
        />
      </div>
      {showDocs
        ? (
          <ul className={css.groupList}>
            {groups.map(({ group, docs }) => (
              <li key={group} className={css.group}>
                <div className={css.groupTitle}>{group}</div>
                <ul className={css.docList}>
                  {docs.map(doc => (
                    <li key={doc.docId} className={css.docRow}>
                      <span className={css.docTitle} title={doc.path}>{doc.title}</span>
                      {!doc.synced ? <span className={css.notSynced}>{t('notSyncedBadge')}</span> : null}
                      <Toggle
                        checked={doc.enabled}
                        label={t(doc.enabled ? 'enabledToggleOn' : 'enabledToggleOff')}
                        onChange={(enabled) => onToggle('doc', doc.docId, enabled)}
                        small
                      />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )
        : null}
    </li>
  )
}

/** A minimal switch used for both repo and doc rows. */
function Toggle(props: {
  checked: boolean
  label: string
  small?: boolean
  onChange: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className={`${css.toggle}${props.checked ? ` ${css.toggleOn}` : ''}${props.small ? ` ${css.toggleSmall}` : ''}`}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className={css.toggleKnob} />
    </button>
  )
}

/**
 * Render the full tree.
 * @param props - repos, expansion map, filter, callbacks, copy.
 */
export function KbTree(props: KbTreeProps): React.JSX.Element {
  const { repos, filter, t } = props
  const filterActive = filter.trim().length > 0
  const matchesFilter = useMemo(() => {
    if (!filterActive) return () => true
    const needle = filter.trim().toLowerCase()
    return (text: string): boolean => text.toLowerCase().includes(needle)
  }, [filter, filterActive])

  const repoVisible = (repo: RepoNode): boolean =>
    !filterActive || matchesFilter(repo.name) || repo.docs.some(doc => matchesFilter(doc.title) || matchesFilter(doc.path))

  return (
    <div className={css.tree}>
      <ul className={css.sectionList}>
        {repos.filter(repoVisible).map(repo => (
          <li key={repo.namespace} className={css.sectionItem}>
            <div className={css.sectionHeader}>{t('myRepos')}</div>
            <ul className={css.repoList}>
              <RepoRow
                repo={repo}
                expanded={props.expanded[`repo:${repo.namespace}`] === true || props.expandAll}
                filterActive={filterActive}
                matchesFilter={matchesFilter}
                t={t}
                onToggleExpand={props.onToggleExpand}
                onToggle={props.onToggle}
              />
            </ul>
          </li>
        ))}
      </ul>
      {repos.length === 0
        ? <p className={css.empty}>{t('neverSynced')}</p>
        : null}
    </div>
  )
}