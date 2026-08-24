# dsh-yuque-kb

把语雀（yuque.com）文档接入 dsh（DeepSeek Harness）作为模型知识库的插件。

- 同步个人（及权限内团队）知识库到本地 FTS5 索引（`node:sqlite`，零原生依赖）
- 模型工具：`kb_sync`（增量同步）/ `kb_search`（本地检索）/ `kb_read`（分块读正文）/ `kb_search_remote`（语雀云端实时搜索）
- 设置面板独立页「知识库」：Token 配置、连接测试、同步状态、树形目录开关、立即同步、进度展示

## 状态

V0.1 开发中，按 `.ref/开发计划-SSOT.md` 分阶段推进（P1 骨架完成）。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run build      # tsc + tsdown（宿主 ESM + 浏览器 closure-factory bundle）
pnpm run test       # vitest
```

## 安装（V0.1 交付时补充）

```sh
dsh plugin --profile web add <path-or-tarball>
```

## 合规与限制

- 语雀开放 API 仅用于正常读写：插件只读、增量同步、默认 3 req/s 节流（5000 次/小时共享额度）
- Token 为超级会员权益；`role('secret')` 存储，不随任何响应回显
- 图片以 URL 引用保留；私有图直链鉴权未支持（V2 评估）