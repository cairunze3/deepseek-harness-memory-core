# vanwork-memory-core 交付清单（v0.8.1）

> 按《DSH 插件开发规范与 TGZ 打包要求》第 9 节提供。
> 交付日期：2026-11-10 · 目标平台：**DSH 0.2.0-rc.2**

---

## 1. 交付物

| 项 | 值 |
|---|---|
| 文件 | `vanwork-memory-core-0.8.1.tgz` |
| 大小 | **401,771 字节**（约 392.4 KiB；解包后 1,188,839 字节，73 个条目） |
| SHA-256 | `230763d6e75fa61aaa34d3a28b08740049520def002954b6a18ceb85a1f881cf` |
| npm shasum | `8f11683b8dba154fa35a11b1627af4581860cbf4` |
| npm integrity | `sha512-M1sye5+gBCnuhgL4gdNNsJrNHrX35FqAGZGPf63Lh9brhkI4zREsJueefbvATfIhr8pwyV/IgHeUH7WaQa6pkA==` |
| 打包方式 | 官方 npm CLI（本机 10.9.3）的 `npm-cli.js` 执行 `npm pack --ignore-scripts`，产物为 npm 原生 tgz（含 `package/` 前缀） |
| 安装方式 | `dsh plugin --profile web add <tgz 绝对路径>`，或在插件页粘贴 tgz 路径 |
| 同目录附加文档 | `安装说明.md`、`记忆插件技术文档.md`、`README.md`、`memory-core-atlas.html`（给同事的导览页）、`MANIFEST.txt`、`SHA256SUMS.txt` |

> 本机 VanWork 运行时只随附 `node.exe`，没有内置 npm；本次用本机可用的官方 npm CLI 10.9.3 打包。npm 10/12 的 tgz 容器格式一致，规范要求的 `package/` 前缀与 `package.json` 元数据均满足。

---

## 2. 插件标识

| 项 | 值 |
|---|---|
| `name` | `vanwork-memory-core`（无 scope；规范允许） |
| `version` | **0.8.1**（较上次交付 `0.7.0` 递增） |
| 目标 dsh 版本 | **0.2.0-rc.2** |
| 一句话功能 | 在 Markdown 记忆正本之上，提供 pointer/index/auto 注入、核心记忆预取、条目级检索、daily-first 写入、队列证据门槛、会话边界抽取、取代式修正、可审计整合与本地管理面板 |
| 源码位置 | 包内 `lib/*.js`：**31 个纯 ESM 模块（30 Host + 1 Client）**，源码即发布字节，无转译、无构建 |
| 行为变更 | 0.8.1 修正 pointer 预取质量：GLOBAL 最多预取 1 条并显示槽值、无日期不输出空分隔、口令/密钥/凭证不自动预取；0.8.0 引入核心预取、`queuePromoteMinHits=2`、保护性 `queue-expire`、`indexMode:auto`、`npm run eval`、`lib/tool-names.js` 单一工具名单 |

---

## 3. 插件形态与注册的插槽

| 项 | 值 |
|---|---|
| 形态 | **Host 半 + Client 半** |
| Host 入口 | `lib/index.js`（导出 `name` / `inject` / `apply` / `DEFAULTS` / `resolveConfig` / `renderSnapshotFor` / `resolveInjectionMode`） |
| `inject` 声明 | `['systemPrompt', 'tools']`（`webServer` 走等待式 `ctx.inject`，刻意不写进声明式 inject） |
| Client 入口 | `lib/client.js`（`window.__ModuleLoader__.load`，`require('react')`） |
| 注册的插槽 | `settings.section`，`id: vanwork-memory-core`，`order: 35`，`label: '记忆管理'` |
| `dsh.client.inject` | `["@deepseek-ai/dsh-client-ui-settings"]` |
| `dsh.client.platform` | `"web"` |

> 规范第 5 节关于 `sidebar.panellist.id == main.key`、`main` 必须声明 `locale` 的约束**不适用**：本插件不注册 `sidebar.panellist` / `main` / `plugins.item` / `conversation.input.left`。

---

## 4. 外部依赖

| 项 | 值 |
|---|---|
| 方案 | **A / B 均不适用——零第三方运行时依赖** |
| 说明 | 只用 `node:` 内建模块：`node:fs` / `node:path` / `node:crypto` / `node:child_process` / `node:os` / `node:url` / `node:sqlite` |
| `dependencies` | 省略（无依赖） |
| `peerDependencies` | 省略：运行时零 `@deepseek-ai/*` 导入；与平台服务只走 cordis `inject` / `ctx.inject` |
| vendor `node_modules` | 无 |
| 构建脚本 | 无；**从未有 `scripts.prepare`**，规范第 7.2 节的打包陷阱不可能发生 |

---

## 5. 配置项（让用户填什么）

**默认即可用**：不写任何配置时，记忆根 `<dshHome>/memories`、状态目录 `<dshHome>/memory-core`，默认 pointer 注入 + 2 条核心预取，全部能力开启。

唯一建议按环境调整的几组：

```yaml
# profile 的 cordis.patch.yml（按 id 顶层覆盖，不要写成 insert）
- id: vanwork-memory-core
  config:
    # ① 与 dsh-memory-evolve 共存时的注入分工（若仍装着旧插件）
    injectExclude: ['global:memory', 'global:user', 'project:key']
    # ② 声明“只用 mem_* 写记忆”——影响 mem_audit 的写入编排判定
    exclusiveWritePath: true
    # ③ pointer 核心预取条数；0 = 关闭，回到“不预载任何条目”
    pointerRecallTopN: 2
    # ④ 队列候选被召回几次才转正（默认 2）
    queuePromoteMinHits: 2
    # ⑤ 注入形态：pointer（默认）/ index / auto
    indexMode: pointer
    # ⑥ 仅 index 模式生效的注入体量
    indexTopN: 32
    indexMaxChars: 10000
```

其余约 100 项均有合理默认值，每项的取舍理由写在 `lib/config.js`，完整表见技术文档 §9.4。

---

## 6. 验收自检清单（规范第 10 节，逐项）

| 项 | 结果 |
|---|---|
| `package.json` 含第 3 节全部必填字段，`exports` 四项齐全 | ✅ `.` / `./client` / `./cordis.patch.yml` / `./package.json` |
| `cordis.patch.yml` 存在 | ✅ 在包内，且 `dsh.bundle.patch` 指向它 |
| 无第 4.1 节已删 API（`sessions.open` / `dsh-client-runtime` / 跨插件值导入） | ✅ 全仓检索无命中；`ctx.on('session/event')` 也未使用 |
| 有 UI 时 `sidebar.panellist.id == main.key`、`main` 声明 `locale` | N/A（不注册这两个插槽）；实际注册 `settings.section` 并已冒烟 |
| 外部依赖按方案 A/B 处理，方案 B 已把 `node_modules` 加进 `files` | N/A（零依赖），已写明 |
| `scripts.prepare` 已删除 | ✅ 从未存在 |
| `npm pack` 成功，tgz 含 `lib/`、`cordis.patch.yml`、`package.json` | ✅ 另含 `README.md`、`docs/`、`scripts/`、`tests/` |
| Host `import()` 加载通过 | ✅ 工作树与解包后各验一次 |
| Client 渲染冒烟通过 | ✅ `scripts/client-smoke.mjs` 全部通过 |
| `version` 较上次递增 | ✅ `0.7.0` → `0.8.1` |
| 附 sha256 与 manifest/README | ✅ 本文 + `SHA256SUMS.txt` + `MANIFEST.txt` + `README.md` |

---

## 7. 验证证据（可复现）

### 7.1 tgz 内容

```
package/package.json                 package/cordis.patch.yml
package/README.md                    package/docs/记忆插件技术文档.md
package/lib/*.js（31 个模块）         package/scripts/*.mjs（12 个）
package/tests/*.test.js（26 个）      共 73 个条目
```

无 `node_modules/`、无 `.last-run.json`、无 `memory-index.db`、无本机运行态文件。

### 7.2 实测命令与结果（在**解包后的包**上跑，不是工作树）

```powershell
$node = "$env:LOCALAPPDATA\Programs\VanWork\resources\runtime\node.exe"
tar -xzf vanwork-memory-core-0.8.1.tgz -C <tmp>; cd <tmp>\package

# ① Host 半可加载（规范第 7 节最小自检）
& $node --input-type=module -e "import('./lib/index.js').then(m=>console.log(Object.keys(m)))"
# → DEFAULTS,apply,inject,name,renderSnapshotFor,resolveConfig,resolveInjectionMode

# ② 单元测试（26 个文件；沙箱禁止 node --test 派生子进程时逐个执行）
& $node --test "tests/*.test.js"
# → 476/476 通过，0 失败

# ③ Client 渲染冒烟
& $node scripts/client-smoke.mjs
# → 全部通过，exit=0

# ④ 端到端自检
& $node scripts/verify.mjs
# → 全部环节跑通，exit=0

# ⑤ 真实装载探针
& $node scripts/mount-probe.mjs
# → 全部通过；file:// 写法 7/7 工具；裸 Windows 路径 0/7（已知平台行为）
```

| 验证 | 结果 |
|---|---|
| 单元测试 | 26 个文件，**476/476** |
| Client 冒烟 | 全部通过 |
| 端到端自检 | 13 步，`exit=0` |
| 真实装载探针 | `file://` 7/7 工具，`exit=0` |
| 跨插件归档契约 | **SKIP**：本机未安装 `dsh-memory-evolve`；命名对齐已由单元测试覆盖 |

### 7.3 包文件哈希

```
230763d6e75fa61aaa34d3a28b08740049520def002954b6a18ceb85a1f881cf  vanwork-memory-core-0.8.1.tgz
```

---

## 8. 已知边界（提交前如实声明）

1. **无按 query 的语义自动召回**：pointer 只预取 global/user/当前项目 key 的少量核心记忆；当前用户消息没有暴露给注入渲染，所以不是完整 auto-recall。
2. **无时序有效性**：没有 `valid_from/valid_to` 与 as-of 查询；只有日期陈旧提醒、取代留档与 90 天队列归档。
3. **无语义向量/reranker**：默认 BM25；向量通道可接，但没有内置模型；`indexMode` 的 auto 只按库大小切换，不是语义路由。
4. **Web 接口无内置鉴权**：`/api/memory-core/*` 只适合本机，不要把端口暴露到局域网。
5. **单机锁**：跨进程写有文件锁，但没有多设备合并 / 团队权限 / 云同步。
6. **口令/密钥只做预取过滤**：口令类条目不自动进每轮输入，但记忆正本仍是明文 Markdown；需要加密请自行放在受控磁盘。
7. **daily→结论不是自动抽取**：仍由模型按写入纪律调用 `mem_write`；`mem_extract` 只在会话边界写 `QUEUE.md` 候选。
8. **依赖 Node ≥ 22.5**（`engines` 已声明）；`node:sqlite` 会打一行 `ExperimentalWarning`，不想看到可设 `backend: 'json'`。

---

## 9. 安装提示

见同目录 `安装说明.md`（三步：放 tgz → 安装 → 重启自检）。要点：

- 安装后**不要**再往 profile 的 `cordis.patch.yml` 手写同 id 的 `insert`（包内 bundle patch 已声明，重复同 id 会让加载器报 `duplicate loader entry id`）；
- tgz 请放在**固定目录**后再安装——包管理器会把它记为 `file:` 依赖，移动/删除 tgz 会让后续安装找不到文件；
- 重启后先跑 `mem_audit`：应看到 **10 个 `mem_*` 工具**，且 `[inject.legacy]` 为未安装/唯一来源。