/**
 * Locale dictionaries for the yuque-kb settings section (zh primary, en copy).
 * Product copy is Chinese; the dictionary keeps both sides for the locale
 * switcher.
 */

export interface YuqueKbKey {
  nav: string
  tokenLabel: string
  tokenPlaceholder: string
  tokenConfigured: string
  tokenNotConfigured: string
  tokenSave: string
  tokenSaved: string
  tokenSaveFailed: string
  testButton: string
  testing: string
  testOk: string
  testFailed: string
  testInvalidToken: string
  lastSync: string
  neverSynced: string
  rateRemaining: string
  syncButton: string
  syncing: string
  refreshButton: string
  expanding: string
  collapseAll: string
  expandAll: string
  filterPlaceholder: string
  myRepos: string
  teamRepos: string
  docsCount: string
  syncedBadge: string
  notSyncedBadge: string
  newBadge: string
  enabledToggleOn: string
  enabledToggleOff: string
  syncProgressRepo: string
  syncProgressDone: string
  syncProgressErrors: string
  sectionDescription: string
  genericError: string
  totalDocs: string
}

/** Every key spelled once; values satisfy Record<string,string> for the locale registry. */
declare const __zh__: YuqueKbKey

export const zh: YuqueKbKey & Record<string, string> = {
  nav: '知识库',
  tokenLabel: 'Access Token',
  tokenPlaceholder: '粘贴语雀个人 Token（超级会员权益）',
  tokenConfigured: '已配置',
  tokenNotConfigured: '未配置',
  tokenSave: '保存',
  tokenSaved: '已保存',
  tokenSaveFailed: '保存失败',
  testButton: '连接测试',
  testing: '测试中…',
  testOk: '连接成功：{name}（{login}），知识库 {booksCount} 个',
  testFailed: '连接失败：{error}',
  testInvalidToken: 'Token 无效或未配置，请先保存 Token',
  lastSync: '上次同步：{time}',
  neverSynced: '尚未同步',
  rateRemaining: '剩余额度 {n}/5000（小时）',
  syncButton: '立即同步',
  syncing: '同步中…',
  refreshButton: '刷新目录',
  expanding: '',
  collapseAll: '全部折叠',
  expandAll: '全部展开',
  filterPlaceholder: '按名称过滤文档',
  myRepos: '我的知识库',
  teamRepos: '团队：{name}',
  docsCount: '{n} 篇',
  syncedBadge: '已同步',
  notSyncedBadge: '未同步',
  newBadge: '新',
  enabledToggleOn: '启用',
  enabledToggleOff: '禁用',
  syncProgressRepo: '正在同步「{repo}」',
  syncProgressDone: '{done}/{total}',
  syncProgressErrors: '{n} 个错误',
  sectionDescription: '将语雀文档作为模型知识库：同步索引、检索与读取（kb_search / kb_read），开关即时生效',
  genericError: '请求失败：{message}',
  totalDocs: '共 {n} 篇已索引',
}

export const en: YuqueKbKey & Record<string, string> = {
  nav: 'Knowledge Base',
  tokenLabel: 'Access Token',
  tokenPlaceholder: 'Paste your Yuque personal token (super member)',
  tokenConfigured: 'Configured',
  tokenNotConfigured: 'Not configured',
  tokenSave: 'Save',
  tokenSaved: 'Saved',
  tokenSaveFailed: 'Save failed',
  testButton: 'Test connection',
  testing: 'Testing…',
  testOk: 'Connected: {name} ({login}), {booksCount} books',
  testFailed: 'Connection failed: {error}',
  testInvalidToken: 'Token invalid or missing — save a token first',
  lastSync: 'Last sync: {time}',
  neverSynced: 'Never synced',
  rateRemaining: '{n}/5000 remaining (hourly)',
  syncButton: 'Sync now',
  syncing: 'Syncing…',
  refreshButton: 'Refresh tree',
  expanding: '',
  collapseAll: 'Collapse all',
  expandAll: 'Expand all',
  filterPlaceholder: 'Filter docs by name',
  myRepos: 'My books',
  teamRepos: 'Team: {name}',
  docsCount: '{n} docs',
  syncedBadge: 'synced',
  notSyncedBadge: 'not synced',
  newBadge: 'new',
  enabledToggleOn: 'Enabled',
  enabledToggleOff: 'Disabled',
  syncProgressRepo: 'Syncing "{repo}"',
  syncProgressDone: '{done}/{total}',
  syncProgressErrors: '{n} errors',
  sectionDescription: 'Use Yuque docs as a model knowledge base: sync, search and read (kb_search / kb_read); toggles apply instantly',
  genericError: 'Request failed: {message}',
  totalDocs: '{n} docs indexed',
}