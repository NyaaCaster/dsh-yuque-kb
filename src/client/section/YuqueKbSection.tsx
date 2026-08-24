/**
 * YuqueKbSection — the dedicated 设置 → 知识库 page.
 *
 * One entry aggregating token config, connection testing, sync status,
 * sync progress and the repo/doc tree with enable toggles. Data flows:
 * - settings-backed token via POST /token (secret, never echoed)
 * - everything else through the /api/dsh-yuque-kb routes (immediate effect)
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KbApi } from '../api.ts'
import type { StatusPayload, TestResult, TreePayload } from '../types.ts'
import type { YuqueKbKey } from '../locales.ts'
import { KbTree } from '../tree/KbTree.tsx'
import css from './YuqueKbSection.module.css'

/** The inject face the section receives at registration. */
export interface YuqueKbSectionInjected {
  api: KbApi
  t: (key: keyof YuqueKbKey, params?: Record<string, string | number>) => string
}

/** Props share: the section is a pure consumer of its injected face. */
export interface YuqueKbSectionProps extends YuqueKbSectionInjected {}

const STATUS_POLL_MS = 3000

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

/**
 * The 知识库 settings section.
 * @param props - api + copy from the registration inject face.
 */
export function YuqueKbSection(props: YuqueKbSectionProps): React.JSX.Element {
  const { api, t } = props
  const [tree, setTree] = useState<TreePayload | null>(null)
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  // Token form (value never displayed back once saved).
  const [tokenInput, setTokenInput] = useState('')
  const [tokenSaving, setTokenSaving] = useState(false)
  const [tokenSaved, setTokenSaved] = useState(false)
  // Connection test.
  const [testing, setTesting] = useState(false)
  const [testLine, setTestLine] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  // Tree view state.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [expandAll, setExpandAll] = useState(false)
  const [filter, setFilter] = useState('')
  const [toggling, setToggling] = useState<Record<string, boolean>>({})
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadTree = useCallback(async (refresh: boolean): Promise<void> => {
    try {
      const payload = await api.readTree(refresh)
      if (!mounted.current) return
      setTree(payload)
      setRefreshError(null)
    } catch (error) {
      if (!mounted.current) return
      setRefreshError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current) setLoaded(true)
    }
  }, [api])

  const pollStatus = useCallback(async (): Promise<void> => {
    try {
      const payload = await api.readStatus()
      if (mounted.current) setStatus(payload)
    } catch {
      // Transient: keep the previous snapshot; the next poll retries.
    }
  }, [api])

  // Initial load + status polling while the page is mounted.
  useEffect(() => {
    void loadTree(false)
    void pollStatus()
    const timer = setInterval(() => { void pollStatus() }, STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [loadTree, pollStatus])

  const tokenConfigured = status?.tokenConfigured ?? tree?.tokenConfigured ?? false

  const handleTokenSave = async (): Promise<void> => {
    if (tokenInput.trim().length === 0) return
    setTokenSaving(true)
    setTokenSaved(false)
    try {
      await api.writeToken(tokenInput.trim())
      setTokenInput('')
      setTokenSaved(true)
      await pollStatus()
    } catch (error) {
      setTestLine({ kind: 'error', text: t('genericError', { message: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setTokenSaving(false)
    }
  }

  const handleTest = async (): Promise<void> => {
    if (!tokenConfigured && tokenInput.trim().length === 0) {
      setTestLine({ kind: 'error', text: t('testInvalidToken') })
      return
    }
    setTesting(true)
    setTestLine(null)
    try {
      // A freshly typed token is saved first; an empty input leaves the
      // configured token untouched (POST /token rejects empty values).
      const newlyTyped = tokenInput.trim()
      if (newlyTyped.length > 0) {
        await api.writeToken(newlyTyped)
        setTokenInput('')
      }
      const result: TestResult = await api.test()
      if (result.ok) {
        setTestLine({ kind: 'ok', text: t('testOk', { name: result.user.name, login: result.user.login, booksCount: result.user.booksCount }) })
        void loadTree(true)
      } else {
        setTestLine({ kind: 'error', text: t('testFailed', { error: result.error }) })
      }
    } catch (error) {
      setTestLine({ kind: 'error', text: t('genericError', { message: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setTesting(false)
    }
  }

  const handleToggle = async (kind: 'repo' | 'doc', id: string, enabled: boolean): Promise<void> => {
    if (tree === null) return
    const key = `${kind}:${id}`
    setToggling(previous => ({ ...previous, [key]: true }))
    // Optimistic patch; roll back on failure.
    const previous = tree
    setTree({
      ...tree,
      repos: tree.repos.map(repo => kind === 'repo' && repo.namespace === id
        ? { ...repo, enabled }
        : { ...repo, docs: repo.docs.map(doc => kind === 'doc' && doc.docId === id ? { ...doc, enabled } : doc) }),
    })
    try {
      await api.toggle({ kind, id, enabled })
    } catch (error) {
      setTree(previous)
      setRefreshError(error instanceof Error ? error.message : String(error))
    } finally {
      setToggling(previousToggling => {
        const next = { ...previousToggling }
        delete next[key]
        return next
      })
    }
  }

  const handleSync = async (): Promise<void> => {
    try {
      const result = await api.startSync()
      if (!result.ok) setRefreshError(result.error ?? t('genericError', { message: 'sync' }))
      void pollStatus()
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleExpandAll = (all: boolean): void => {
    setExpandAll(all)
    if (all) {
      setExpanded({})
    } else {
      setExpanded({})
      setExpandAll(false)
    }
  }

  const handleToggleExpand = (key: string): void => {
    setExpandAll(false)
    setExpanded(previous => ({ ...previous, [key]: !(previous[key] === true) }))
  }

  const syncing = status?.syncing === true
  const progress = status?.progress ?? null
  const totalDocs = tree === null ? 0
    : tree.repos.reduce((sum, repo) => sum + repo.docs.length, 0)

  return (
    <div className={css.section}>
      {/* ① Connection: token + test. */}
      <div className={css.block}>
        <div className={css.row}>
          <label className={css.label} htmlFor="yuque-kb-token">{t('tokenLabel')}</label>
          <input
            id="yuque-kb-token"
            className={css.input}
            type="password"
            autoComplete="off"
            placeholder={tokenConfigured ? t('tokenConfigured') : t('tokenNotConfigured')}
            value={tokenInput}
            onChange={(event) => { setTokenInput(event.target.value); setTokenSaved(false) }}
          />
          <button
            type="button"
            className={css.button}
            disabled={tokenInput.trim().length === 0 || tokenSaving}
            onClick={() => { void handleTokenSave() }}
          >
            {tokenSaving ? t('syncing') : tokenSaved ? t('tokenSaved') : t('tokenSave')}
          </button>
        </div>
        <div className={css.row}>
          <span className={`${css.badge} ${tokenConfigured ? css.badgeOk : ''}`}>
            {tokenConfigured ? t('tokenConfigured') : t('tokenNotConfigured')}
          </span>
          <button
            type="button"
            className={css.button}
            disabled={testing}
            onClick={() => { void handleTest() }}
          >
            {testing ? t('testing') : t('testButton')}
          </button>
          <button
            type="button"
            className={css.ghostButton}
            onClick={() => { void loadTree(true) }}
          >
            {t('refreshButton')}
          </button>
        </div>
        {testLine !== null
          ? (
            <p className={testLine.kind === 'ok' ? css.testOk : css.testError} role="status">
              {testLine.text}
            </p>
          )
          : null}
      </div>

      {/* ② Sync status line. */}
      <div className={css.block}>
        <div className={css.row}>
          <span className={css.statusText}>
            {status?.lastSyncAt !== null && status?.lastSyncAt !== undefined
              ? t('lastSync', { time: formatTime(status.lastSyncAt) })
              : t('neverSynced')}
          </span>
          <span className={css.statusText}>
            {status?.rateRemaining !== null && status?.rateRemaining !== undefined
              ? t('rateRemaining', { n: status.rateRemaining })
              : ''}
          </span>
          <span className={css.statusText}>{t('totalDocs', { n: totalDocs })}</span>
          <button type="button" className={css.button} disabled={syncing} onClick={() => { void handleSync() }}>
            {syncing ? t('syncing') : t('syncButton')}
          </button>
        </div>

        {/* ③ Sync progress. */}
        {syncing && progress !== null
          ? (
            <div className={css.progress}>
              <div className={css.progressLine}>
                <span className={css.progressFill} style={{ width: `${progress.total === 0 ? 0 : Math.min(100, Math.round((progress.done / progress.total) * 100))}%` }} />
              </div>
              <span className={css.progressText}>
                {progress.repo !== undefined ? t('syncProgressRepo', { repo: progress.repo }) : progress.phase}
                {' '}
                {t('syncProgressDone', { done: progress.done, total: progress.total })}
              </span>
              {progress.errors.length > 0
                ? <span className={css.progressErrors}>{t('syncProgressErrors', { n: progress.errors.length })}</span>
                : null}
            </div>
          )
          : null}
      </div>

      {refreshError !== null ? <p className={css.testError} role="alert">{refreshError}</p> : null}

      {/* ④ Tree with toolbar. */}
      <div className={css.block}>
        <div className={css.row}>
          <button type="button" className={css.ghostButton} onClick={() => handleExpandAll(true)}>{t('expandAll')}</button>
          <button type="button" className={css.ghostButton} onClick={() => handleExpandAll(false)}>{t('collapseAll')}</button>
          <input
            className={`${css.input} ${css.filterInput}`}
            type="text"
            placeholder={t('filterPlaceholder')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        {loaded
          ? (
            <KbTree
              repos={tree?.repos ?? []}
              expanded={expanded}
              expandAll={expandAll}
              filter={filter}
              t={t}
              onToggleExpand={handleToggleExpand}
              onToggle={(kind, id, enabled) => { void handleToggle(kind, id, enabled) }}
            />
          )
          : <p className={css.empty}>{t('neverSynced')}</p>}
        {toggling ? null : null}
      </div>
    </div>
  )
}