# dsh-yuque-kb

把语雀（yuque.com）文档接入 dsh（DeepSeek Harness）作为模型知识库的插件（**在线优先**）。

- 增量同步个人知识库**目录快照**到本地（toc 树 + 文档清单，仅 ~17 请求，安全）；**正文不落本地**（实测语雀对连续大量抓取触发短窗风控，在线读取规避）
- **被动注入**：对话内容与语雀文档相关时自动检索并注入文档片段（外部记忆，无需点名）；也可显式使用工具 `kb_sync`（目录增量同步）/ `kb_search`（本地目录标题/路径检索，零额度）/ `kb_read`（在线分块读正文）/ `kb_search_remote`（语雀云端全文搜索）
- `systemPrompt` 公告段（order 150，`announceToAgent` 可关）
- `/api/dsh-yuque-kb/*` 路由族（loopback 信任栅栏）：`test` / `tree` / `toggle` / `sync` / `status` / `token`
- 设置面板独立页「语雀知识库」（P5）：Token 配置、连接测试、同步状态、树形目录开关、立即同步、进度展示

## 状态

V0.1 开发中，按 `.ref/开发计划-SSOT.md` 分阶段推进（P1–P5 完成；P6 集成验证中；2026-08-26 拍板**在线优先**：否决本地正文库）。

## 配置（cordis.yml / 设置面板「语雀知识库」）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 插件总开关（路由/工具/公告段） |
| `announceToAgent` | boolean | `true` | 是否向模型公告本插件能力 |
| `syncOnStartup` | boolean | `false` | 启动时自动增量同步目录（仅 token 已配置时） |
| `yuqueToken` | string (secret) | `''` | 语雀 token；`role('secret')`，任何响应不回显 |
| `rateLimitPerSec` | number | `3` | 语雀客户端节流（合规：5000 次/小时共享额度） |
| `searchLimit` | number | `8` | `kb_search` 默认命中数（1..20） |
| `blockCharLimit` | number | `512` | `kb_read` 分块字符上限 |
| `timeoutMs` | number | `30000` | 远程抓取类工具（`kb_read`、`kb_search_remote`）超时预算 |
| `autoInject` | boolean | `true` | **被动注入**：对话回合自动检索语雀目录并把相关文档片段注入请求（无需点名插件/文档） |
| `autoInjectRemote` | boolean | `true` | 被动注入本地未命中时回退语雀云端全文搜索（每次探测 1 请求） |
| `autoInjectIntervalMs` | number | `30000` | 单会话内被动注入的最小间隔 |
| `autoInjectMinQueryChars` | number | `8` | 触发被动探测的最短用户消息长度 |

Token 解析优先级：设置文档/组合配置的 `yuqueToken` → `POST /api/dsh-yuque-kb/token` 存入的领域全局运行期凭据（无设置服务部署时的降级路径，见下）。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run build      # tsc + tsdown（宿主 ESM + 浏览器 closure-factory bundle）
pnpm run test       # vitest（含真实组合测试 tests/composition.spec.ts）
```

## 安装

```sh
# 方式一：本地开发目录（link）
dsh plugin --profile web add link:H:\GitHub\dsh-plugin\dsh-yuque-kb

# 方式二：npm 发布后
dsh plugin --profile web add dsh-yuque-kb

# 方式三：tarball（pnpm pack 产物）
dsh plugin --profile web add ./dsh-yuque-kb-0.1.0.tgz
```

安装后**重启 dsh web**（插件加载进 GUI）：设置面板出现「知识库」页，
聊天中模型可用 `kb_search` / `kb_read` / `kb_sync` / `kb_search_remote`。

移除：`dsh plugin --profile web remove dsh-yuque-kb`。

## 合规与限制（Known Limitations）

- 语雀开放 API 仅用于正常读写：插件只读、目录同步 + 在线读取、默认 3 req/s 节流、429 退避、详情偶发 404 有限重试。
- **风控实测**：语雀对连续大量抓取有短窗风控（~25 连发即 429、无 Retry-After、数小时不解）→ **正文不落本地**，`kb_read`/`kb_search_remote` 按需在线读取（每篇 1-2 请求，日常使用安全）；目录同步仅 ~17 请求。
- Token 为超级会员权益；secret 字段经 `role('secret')` 存储，不随任何响应回显。
- `kb_search_remote` 缺省 scope 是**客户端过滤近似**（按结果 URL 首段过滤到个人知识库），非语雀服务端 scope 限制；显式 `scope` 参数原样透传（库 namespace）。
- `kb_search` 只检索本地目录的**标题/路径**（无正文本地副本、无 snippet）；全文内容请用 `kb_search_remote` + `kb_read`。
- 后台任务（`kb_sync` 后台 / `/api/.../sync` jobId）依赖宿主装配 `@deepseek-ai/dsh-jobs`；未装配或注册被拒时 `/sync` 路由降级为前台同步。
- 图片以 URL 引用保留；私有图直链鉴权未支持（V2 评估）。
- 本地只存目录快照（repos/tocs/docs 元数据与开关）；正文不落盘（在线优先，见上）。