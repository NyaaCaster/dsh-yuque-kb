# dsh-yuque-kb

把语雀（yuque.com）文档接入 dsh（DeepSeek Harness）作为模型知识库的插件。

- 增量同步个人知识库到本地 FTS5 索引（`node:sqlite`，零原生依赖）
- 模型工具：`kb_sync`（增量同步，支持后台任务）/ `kb_search`（本地离线检索，不耗语雀额度）/ `kb_read`（分块读正文，未同步文档实时回源）/ `kb_search_remote`（语雀云端实时搜索兜底）
- `systemPrompt` 公告段（order 150，`announceToAgent` 可关）
- `/api/dsh-yuque-kb/*` 路由族（loopback 信任栅栏）：`test` / `tree` / `toggle` / `sync` / `status` / `token`
- 设置面板独立页「知识库」（P5）：Token 配置、连接测试、同步状态、树形目录开关、立即同步、进度展示

## 状态

V0.1 开发中，按 `.ref/开发计划-SSOT.md` 分阶段推进（P1–P4 完成：骨架 / 语雀 Adapter / 本地存储与 FTS5 / 宿主能力，P5 浏览器设置页完成，P6 集成收尾）。

## 配置（cordis.yml / 设置面板「知识库」）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 插件总开关（路由/工具/公告段） |
| `announceToAgent` | boolean | `true` | 是否向模型公告本插件能力 |
| `syncOnStartup` | boolean | `false` | 启动时自动增量同步（仅 token 已配置时） |
| `yuqueToken` | string (secret) | `''` | 语雀 token；`role('secret')`，任何响应不回显 |
| `rateLimitPerSec` | number | `3` | 语雀客户端节流（合规：5000 次/小时共享额度） |
| `searchLimit` | number | `8` | `kb_search` 默认命中数（1..20） |
| `blockCharLimit` | number | `512` | 正文分块字符上限（FTS 索引粒度） |
| `timeoutMs` | number | `30000` | 远程抓取类工具（`kb_read` 回源、`kb_search_remote`）超时预算 |
| `indexPath` | string | `~/.dsh/dsh-yuque-kb/index.sqlite` | FTS 索引库路径 |

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

- 语雀开放 API 仅用于正常读写：插件只读、增量同步、默认 3 req/s 节流、429 退避、详情偶发 404 有限重试。
- Token 为超级会员权益；secret 字段经 `role('secret')` 存储，不随任何响应回显。
- `kb_search_remote` 缺省 scope 是**客户端过滤近似**（按结果 URL 首段过滤到个人知识库），非语雀服务端 scope 限制；显式 `scope` 参数原样透传（库 namespace）。
- `synced` 标记约定：文档记录 `format` 非空即视为已索引；刷新目录产生的占位记录（正文未拉取）显示为未同步。
- 后台任务（`kb_sync` 后台 / `/api/.../sync` jobId）依赖宿主装配 `@deepseek-ai/dsh-jobs`；未装配时后台调用报错、`/sync` 路由降级为前台同步（请求阻塞至完成）。
- 图片以 URL 引用保留；私有图直链鉴权未支持（V2 评估）。
- 正文不进 KV/domain（仅元数据），FTS 索引存分块正文。