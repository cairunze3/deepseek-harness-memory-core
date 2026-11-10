# vanwork-memory-core

> **一句话**：给 VanWork（DeepSeek Harness）补上记忆系统的"下半身"——**索引常驻 + 硬预算 + 条目级检索 + 自我整合 + 云端分层**，
> 并在 0.3.0 起**接管写入编排（跨进程锁 + 备份 + 原子写 + 取代留档）与常驻注入**。
> 它**不拥有**记忆内容，只拥有可随时重建的派生索引；记忆正本仍然是磁盘上的 Markdown。

```text
记忆正本（Markdown，与 dsh-memory-evolve 共用同一批文件）
        │  只读扫描
        ▼
派生索引（SQLite FTS5 / 纯 JS 兜底，可整份删除重建）
        │
        ├── 每轮注入：常驻索引（硬预算 120 行 / 8KB，溢出即自修复）
        │              + 会话身份行 + 每轮写入交接提醒
        ├── 写入编排：mem_write → memfile（文件锁 + 互操作锁 + 备份 + 原子写 + 格式保留）
        ├── 按需检索：mem_search（BM25 + 可选向量 + RRF 融合）
        ├── 自证授权：mem_audit（"到底谁在管存储"的可复算报告）
        ├── 低频整合：mem_consolidate（近重复合并 / 日志蒸馏 / 冷条目归档）
        └── 云端分层：classifyEntry + redactForCloud（v0.1 只判定，不联网）
```

> **0.3.0 的接管边界（一句话）**：写入编排与注入编排已归本插件；旧实现的
> `memory` 工具仍与它并装着（它没有可关的开关），所以 `mem_audit` 会把这条
> 如实标成"写入面双份"，并给出收编它的两种做法。见第 2.1 节。

---

## 1. 它补的是哪四个缺口

| 缺口 | 现状 | 本插件的做法 |
|---|---|---|
| **索引不是一等公民** | KEY 记忆按需注入摘要，但没有"全轨索引 + 硬预算" | 每轮注入一份受**双预算**约束的索引；正文按指针展开 |
| **记忆没有条目级检索** | 有文件名/内容级本地文件搜索，但没有"在记忆条目上做 BM25" | `mem_search`：中文 bigram + FTS5 BM25，可融合向量（RRF） |
| **整合靠自觉** | 有 `memory-consolidate` 技能（模型驱动） | `mem_consolidate`：**可复算的方案 + 指纹校验 + 备份回滚**，纯计算与落刀分离 |
| **上云没有判定层** | 有 Git 记忆同步（很强），但没有"哪条能离机"的判断 | `classifyEntry` / `redactForCloud`：两条轴 + 三道闸门（详见设计文档第 6 章） |

### 1.1 当前的云端范围（2026-10-26 拍板）

**离机副本只允许 `user` 一轨**——多设备只共用身份/习惯类记忆，会话类、项目类、
以及"这台机器的属性"（`memory` 轨）全部保持本机。第三方服务允许"脱敏片段"
级别的嵌入/检索，但原始流水与审计禁止。

`mem_health({cloud: true})` 会直接给出范围汇总：

```
跨设备范围：user 轨 · 会离机 2 条 · 保持本机 9 条
离机判定：可离机 2 · 需脱敏后离机 0 · 禁止离机 9
第三方服务：redacted-snippets-only:8 · no:3
```

单轨范围可用 `cloudTierOverrides` 覆盖，例如把 `key` 轨也纳入跨设备：

```yaml
- id: vanwork-memory-core
  config:
    cloudTierOverrides:
      key: { offsite: 'yes' }
```

## 2. 与 dsh-memory-evolve 的边界（刻意不抢任何东西）

| 维度 | dsh-memory-evolve | vanwork-memory-core |
|---|---|---|
| 记忆正本 | 共用同一批文件（`<dshHome>/memories/**.md`） | 共用，**不另建存储**；写入走自己的锁/备份/原子写 |
| 工具名 | `memory` / `memory_suggest` / `dtodo` / `de_*` | `mem_*`（完全不撞名） |
| 待办 / 会话编排 / 画板 / 通知 | 提供 | 不碰 |
| 写入编排 | `memory` 工具 + 记忆 Tab 的按条目 API | **memfile 原语**（文件锁 + 互操作锁 + 备份 + 原子 rename + 格式保留） |
| 索引注入 | 注入 global MEMORY/USER + project KEY + 每轮职责/看门狗提示 | 注入**其余轨的全轨索引**（`order=520`）+ 会话身份行 + 每轮写入交接 |
| 整合 | 技能（模型驱动） | 计划/执行分离 + 指纹校验 |
| 云端 | 私有 Git 记忆仓库同步 | 分层判定 + 上云前脱敏（v0.1 不联网） |

> 为什么不做成 memory-evolve 的补丁：那个包在 profile 里标了
> `vanwork.managedByHost: true`（由 VanWork 托管、随升级整体替换），
> 改它等于改一个会被覆盖的文件。做成独立 bundle 才能长期存活。
>
> **唯一"必须一致"的接口是归档文件命名**（2026-10-26 用户拍板）：本插件的
> `archiveRelFor` 与对方的 `ArchiveStore.fileOf` 逐字对齐——`MEMORY-archive.md` /
> `USER-archive.md` / `projects/<id>/KEY-archive.md`。不对齐时，本插件产生的
> 归档与取代留档在它的记忆 Tab 归档页里**看不见、也移不回主记忆**。

### 2.1 0.3.0：存储编排与注入的接管（以及还没接管的）

**已经归本插件**（可被 `mem_audit` 证伪，见第 5 节工具表）：

- **写入编排**：`mem_write` 的 add / replace / remove / supersede 全部落到
  `lib/memfile.js` 的四个原语上，每个原语都是「**文件锁内重新读文件** → 备份 →
  原子写 → 按既有格式重组」。锁有两层：自己的一把 `.<文件名>.lock`（粒度=目标
  文件），以及**与对方互操作**的 `<记忆目录>/.memory.lock`（它的记忆 Tab 编辑
  与 `memory` 工具都在那把锁里写同一批文件）。取不到锁就**如实失败**，绝不静默写。
- **常驻注入**：全轨索引 + 会话身份行（与对方的 `snap.sessionPlain/Named` 逐字
  同款，广播/协作流程读它）+ 每轮写入交接提醒（按会话分段、写入即归零、只输出
  阈值布尔以保护 prompt 缓存前缀）+ `{{…}}` 净化。

**还没接管、也不打算假装接管**：

- **对方的 `memory` 工具**（`lib/index.js:1716` **无条件注册**，没有任何开关；
  改它只能改它的静态 config 或摘掉它的插件行）。它和 `mem_*` 不撞名，所以
  两个写入面同时存在——`mem_audit` 会报 `dual-write-surface`。
- **对方的快照注入**：`injectMemory` 是**静态 config**，`plugin-state.json`
  里的同名键**不生效**（只有 `RUNTIME_KEYS` 会被回灌，实测勘察见设计文档 §13）。
  所以要"注入只剩一条来源"，只能在 profile 里给它传静态 config，或摘掉它的
  插件行——而那会**连坐**它的会话身份段、每轮看门狗、评审 due 提醒与 dtodo 收尾
  提示（它们挂在同一段注册分支里）。本插件的分工策略因此是**让出它负责的三条轨**
  （`injectExclude: ['global:memory','global:user','project:key']`），两边都不重复注入。

## 3. 安装

**已交付但未替你安装**：安装要写 `$DSH_HOME/profiles/web`（在本工作区之外），会触发沙箱授权，也可能影响你正在用的 VanWork。请自行决定时机。

```powershell
# 方式一：用 dsh CLI（推荐，会自动应用 bundle patch）
& "$env:LOCALAPPDATA\Programs\VanWork\resources\runtime\node.exe" `
  "$env:LOCALAPPDATA\Programs\VanWork\resources\runtime\app\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile web add C:\Users\cairz01\VanWork\plugins\vanwork-memory-core

# 然后重启 dsh web（插件在启动时装载）
```

安装后**不要再往 profile 的 `cordis.patch.yml` 手写 insert** —— 包内
`cordis.patch.yml` 已声明 `dsh.bundle.patch`，重复同 id 会让加载器报
`duplicate loader entry id` 起不来。

**卸载 / 临时禁用**

```powershell
# 卸载
dsh plugin --profile web remove vanwork-memory-core

# 或临时禁用（在 profile 的 cordis.patch.yml 加一行，无需卸载）
# - id: vanwork-memory-core
#   disabled: true
```

## 4. 配置

在 profile 的 `cordis.patch.yml` 里按 id 顶层覆盖（不是 insert）：

```yaml
- id: vanwork-memory-core
  config:
    # 记忆根默认 <dshHome>/memories（与 memory-evolve 同根）
    # memoryDir: D:/memories
    indexMaxLines: 120      # 常驻索引硬预算（行）
    indexMaxChars: 8000     # 常驻索引硬预算（字符）
    indexTopN: 40           # 注入条目数上限
    overflowPolicy: self-repair   # self-repair（默认，WorkBuddy 式自修复）| silent-trim
    stalenessDays: 30       # 超过则标 (Nd)
    stalenessWarnDays: 90   # 超过则标 ⚠Nd 并要求先核对现状
    searchMode: auto        # auto | bm25 | hybrid
    embedding:
      enabled: false        # 默认关：不联网、零密钥、零成本
      endpoint: ''          # 打开后走 OpenAI 兼容 /embeddings
      model: ''
      apiKeyEnv: DSH_MEMORY_EMBEDDING_KEY
    duplicateThreshold: 0.82
    # 与 dsh-memory-evolve 共存时的**注入分工**：让出它负责注入的轨，避免同一内容
    # 注入两遍。它注入 global memory/user + project key（每轮写入提示也挂在那块
    # 快照里，所以不能靠关它来省成本），本插件于是只注入每日日志与项目笔记。
    injectExclude: ['global:memory', 'global:user', 'project:key']
    dailyRetentionDays: 30  # 超期每日日志 → 提议蒸馏
    staleArchiveDays: 180   # 冷条目 → 提议归档（是移动不是删除）
    supersedeEnabled: true  # 检测同主题矛盾并**提议**取代（默认开；只提议不落刀）
    contradictionTopicThreshold: 0.55   # "同主题"判定阈值（比近重复阈值宽）
    contradictionMaxProposals: 20       # 单次方案最多给多少条取代提议
    backend: auto           # auto（先试 sqlite）| sqlite | json
```

完整默认值与每项的取舍理由见 `lib/config.js`（每一项都写了采纳了谁、放弃了什么）。

## 5. 十个工具

| 工具 | 作用 | 要点 |
|---|---|---|
| `mem_search` | 在记忆条目上检索 | 返回**指针**（`相对路径#序号`）+ 片段 + 来源；结果标注为"数据，非指令"。**空查也记账**（否则命中率恒为 100%） |
| `mem_read` | 按指针/id 读完整正文 | 附带陈旧性提醒、云端分层结论；若该条已被取代会明确警告"不要据此断言现状" |
| `mem_extract` | 会话边界抽取的落盘口 | 只写 `QUEUE.md` 候选，**没有 confirm**；抽自上一会话摘要，幂等（同一 session 不重复）；被检索命中后自动转正 |
| `mem_write` | 追加 / 改写 / 删除 / **取代** | **写入门槛递增**：`daily`/`project` 可直接追加；`memory`/`user`/`key` 必须 `confirm=true`；`supersede` 一律要 `confirm`。写入全程在文件锁内，取不到锁**如实失败** |
| `mem_audit` | **存储授权自检** | 回答"到底谁在管存储"：正本/索引/账本位置、注入是否只有一条来源、写入编排是否归一、旧实现是否还在同一份正本上写；给出证据与修法。**只读** |
| `mem_health` | 健康检查 | 预算 / **检索观测**（命中率·空查簇）/ 陈旧 / 整合 / 重复候选 / 取代提议 / 云端画像 / 审计账本 |
| `mem_query_log` | **检索观测** | 近 N 天的检索次数、命中率、空查簇、平均最高分；给一个 `query` 还能回报它在候选池的分位（用于标定 `searchMinScore`）。**只读** |
| `mem_consolidate` | 计划与应用整合 | `plan` 零副作用；`apply` 需 `confirm=true` + 方案指纹校验；方案里的**取代提议默认不执行**，要落地须再传 `supersede=true` |
| `mem_reindex` | 重建索引 | 索引是派生物，重建永远安全 |
| `mem_global` | 全局记忆槽位 | `GLOBAL.md` 的 8 槽模型：槽间叠加、槽内重写、槽数封顶 |

`mem_audit` 的输出形状（本机实测，2026-10-27）：

```text
判定：**memory-core (own store + own tools)**
  · 常驻注入：两套并存（尚未归一）
  · 写入面：新旧两套工具都能写（尚未收编旧 memory 工具）
## 逐项证据
✓ [store.canon] 记忆正本（Markdown） … 条目 30 · 文件 4 · 轨道 memory:12 · daily:14
✓ [index.self] 自有派生索引（新插件） … 后端 sqlite
⚠ [inject.legacy] 旧的快照注入 … 探测：仍在注册 systemPrompt.context，且没有 plugin-state.json → 两套注入同时在跑
## 归一状态
常驻注入归一（唯一来源）：否 · 写入编排归新插件：是 · 正本与索引自持：是
```

## 6. 记忆的修正与删除（三级语义）

**默认永不真删。** 记忆系统的常态操作是**修正**，不是删除——把删除当主要手段，会让系统变得健忘且不可审计。所以：

| 级别 | 动作 | 语义 | 可恢复 | 触发 |
|---|---|---|---|---|
| **L1** | 归档 | "这条不该再占注意力了" → 移入归档轨（`MEMORY-archive.md` / `USER-archive.md` / `projects/<id>/KEY-archive.md`，即对方记忆 Tab 的归档页签），不注入、默认不召回 | ✅ | 整合时冷条目（自动） |
| **L2** | **取代** | "这条**是错的**，正确结论在别处" → 打 `[superseded-by:<id>]` 并留档归档 | ✅ 可回溯 | 手动 `mem_write action=supersede`；整合时**提议**（默认不执行） |
| **L3** | 销毁 | "这东西不该存在于任何地方" → 穷尽式销毁 | ❌ | **尚未实现**；只对凭证类与法律要求开放，见设计文档 §6.8 |

**L2 的用法**（结论变更请用它，不要用 `replace`）：

```
mem_write(action="supersede", track="key", scope="project",
          match="旧的结论片段",                 # 定位被取代的那条
          content="修正后的结论",               # 会先写成新条目，再让旧条目被它取代
          confirm=true)
mem_write(action="supersede", ..., replacement="KEY.md#2", confirm=true)  # 或用已有条目取代
```

- 旧条目**留档进归档轨**并带取代标记，`mem_search(includeArchived=true)` 可回溯"我们曾经以为 X，后来发现 Y"；
- 被取代的条目**不进常驻索引、默认不被召回**——修正的价值在于"不再误导"，而不只是"记下来"；
- `replace` 只用于措辞修正这类不涉及结论变更的编辑（旧文本会消失）。

整合时会检测**同主题矛盾**（相似度够高 + 命中"改为/不再/已废弃"这类修订标记，或同一个键被赋了不同的值）并把它列为**取代提议**，附上判据原文；每条提议都要你确认，`apply` 时不带 `supersede=true` 就一个文件都不会动。

> 冲突优先级：**矛盾 > 重复**。一对话义矛盾的条目相似度往往也很高，若当成近重复合并掉，旧结论会被静默删除、修正痕迹随之消失（开发时实测踩到过，已固化为回归测试）。

## 7. 安全与回滚

- **写时校验**：`user` 不许写进项目目录、`key` 不许写进记忆根、`scope` 与目录必须一致（Qoder 的 pinned type 思路）——写错直接拒绝，不靠模型自觉。
- **跨进程锁**（0.3.0）：所有写原语在锁内**重新读文件**再做"读-改-写"。两层锁：自己的 `.<文件名>.lock`（同目录，粒度=目标文件，线程内不做重入，4s 上限）与**与 memory-evolve 互操作**的 `<记忆目录>/.memory.lock`（它的 `memory` 工具与记忆 Tab 编辑都在那把锁里写同一批文件；我们只抢、**绝不删别人的锁文件**）。取不到锁 → **如实失败 + 文件一个字节不改**，绝不静默继续写。
- **改前必备份**：所有改动记忆正本的操作都先复制到 `<coreDir>/backups/<日期>/`（备份在锁内做，保证备份与写入是同一版本）。
- **原子写**：临时文件 → fsync → rename；断电不留半截文件。
- **锁内重校验**：`replace`/`remove`/`supersede` 的匹配取自**扫描快照**，但真正落刀前会在锁内确认"该条目的正文仍然存在"；已被并发改动就带回原因失败，不会改成别的东西。
- **保留原格式**：只按文件既有的分隔方式重组，绝不把一份文件"顺手"改成另一种格式（它同时被 memory-evolve 读写）。**唯一例外**是与对方同名的归档文件（`MEMORY-archive.md` / `USER-archive.md` / `KEY-archive.md` / `TODO-archive.md`）：这些**一律按 `§` 规范落盘**——对方的 `parseEntries` 只认 `§`，若按"时间戳行"追加，两条会在它的归档页里并成一条（点"移回主记忆"时整块搬回主轨）。
- **不擅自落刀**：整合默认**不删除**原始日志（`deleteSource=false`）；归档与取代都是移动 + 留档，不是删除。
- **计划指纹**：`planId` 由方案内容算出（**含取代提议**），计划生成后记忆一变就失配，`apply` 直接拒绝——执行的一定是你看过的那一份。
- **故障不拖垮宿主**：索引打不开 → 降级为"只剩提示文本"；注入渲染异常 → 返回一行 `status="degraded"`，绝不把异常抛进 DSH 的组装链路。
- **审计账本**：`<coreDir>/ledger.jsonl`（append-only + 稀疏索引），记录每次检索/写入/整合的元数据（**不含记忆正文**）。

## 8. 已知边界（不假装没有）

1. **`node:sqlite` 目前标记为 experimental**，Node 启动时会打一行 `ExperimentalWarning`。不想要这行告警就把 `backend` 设为 `json`（纯 JS 倒排索引，条目数千级够用）。
2. **没有替你执行最后的 `dsh plugin add`**：安装要写 `$DSH_HOME/profiles/web`（工作区之外，会触发授权，也可能影响你正在用的 VanWork）。但"能不能装"已经被两段真实验证覆盖，见第 8 节的 `probe:mount` 与 `probe:profile`——**唯一仍未做的只是把文件写进你的 profile 并重启**。
3. **向量检索默认关闭**：本机没有嵌入服务，默认联网等于给每次检索加一笔不可见成本与一次隐私外发。打开后失败一律降级为纯 BM25。
4. **整合质量依赖模型**：`distill` 的机械拼接只是兜底，更好的做法是让模型写 `distilledText` 再 apply（机制在代码，质量在模型）。
5. **锁是单机的**：跨设备并发由 Git 侧的三方合并解决，本锁不承担跨机互斥。
6. **扫描上限**：默认 ≤5000 文件 / 深度 6，防止误配根目录时把整盘扫进内存。
7. **`archive` 轨不注入**：归档的目的就是不占常驻预算，需要时用 `mem_search(includeArchived=true)` 召回。
8. **与 memory-evolve 同装时是"分工注入"而不是"归一注入"**：默认 `injectExclude: ['global:memory','global:user','project:key']`，让它的快照继续负责它那三段（它那三段里还挂着每轮职责提示与看门狗，关不掉而不连坐），本插件负责其余轨。`mem_audit` 会把这条如实报成 `inject.legacy ⚠ 两套注入同时在跑`——**这是有意保留的状态，不是故障**。要真正归一，做法与连坐代价见 §2.1。
9. **旧实现的 `memory` 写入工具仍然存在**：它无条件注册、没有开关，所以"写入面"目前是双份（`mem_audit` 报 `dual-write-surface`）。两套写的是同一批文件、都遵守格式契约，但只有本插件这一侧有跨进程锁与"锁内重校验"；**建议约定只用 `mem_*` 工具写入**。
10. **项目日志 / 每日日志的归档仍是私名**（`projects/<id>/archive/project-<日期>.md`、`archive/daily-<日期>.md`）：memory-evolve 只给 memory / user / key 三轨做了归档页签，这两轨没有对应界面，改成 `MEMORY-archive` 只会让文件从"按日期可辨"变成含义不明。要图形化看到它们，目前只能靠 `mem_search(includeArchived=true)`。
11. **早期私名归档不迁移**：`archive/*.md` 里的历史归档继续被扫描、检索与召回（`classifyFile` 两种形态都认），只是新归档不再写入那里——避免一次"为了整齐"的批量搬运。
12. **两个写入者之间只有"状态桥接"，没有计数器互通知**：本插件通过**记忆文件 mtime 的推进**判断"有人刚写过"（`detectExternalWrite`，保守规则、绝不拿 `Date.now()` 当基线），从而归零自己的"未写"计数；旧实现的计数器不会被我们改动，它的看门狗仍可能自行判断。这与第 9 条是同一件事的两面：约定只用 `mem_*` 写，这类跨实现协调就不需要了。

### 8.1 让配置真正生效：`apply-profile-config`

上面第 1 条的"写文件进 profile"现在有了一个幂等、可回滚的脚本（**默认 dry-run**）：

```powershell
$node = "$env:LOCALAPPDATA\Programs\VanWork\resources\runtime\node.exe"
$home = "$env:APPDATA\VanWork\accounts\<你的 account id>\dsh-home"   # 也可用 DSH_HOME 环境变量

# ① 先看它要改什么（不写任何文件）
$env:DSH_HOME = $home; & $node scripts/apply-profile-config.mjs
# ② 确认后再落盘（会备份 + 生成回滚脚本）
& $node scripts/apply-profile-config.mjs --apply
Remove-Item Env:DSH_HOME
```

它会往 `id: vanwork-memory-core` 那个条目的 `config:` 段里**只加/改这三个键**（其余内容逐字节不动）：

| 键 | 值 | 为什么 |
|---|---|---|
| `injectExclude` | `['global:memory', 'global:user', 'project:key']` | 与 memory-evolve 分工注入（旧插件已移除后：这三条轨目前没有文件，属空操作；将来清空即由本插件接管） |
| `exclusiveWritePath` | `true` | 声明"只用 `mem_*` 写记忆" → `mem_audit` 的"写入编排归新插件"转为**是** |
| `indexTopN` | `32` | 注入条数上限。2026-10-28 由 36 降到 32，配合下面的字符预算留余量 |
| `indexMaxChars` | `10000` | 注入字符预算。2026-10-28 由默认 8000 提到 10000：实测 32 条 / **6805 字符（68%）**，不再溢出 |

写入后它会打印**备份路径**与一条 `rollback-memory-core-config.ps1` 的路径——回滚就是跑那个脚本。生效需要重启 VanWork。

### 8.2 写入约定：只用 `mem_*` 写记忆（2026-10-27 用户拍板）

**约定本身**：写/改记忆只用新插件的 `mem_*` 工具，不用旧插件的 `memory` 工具。

**为什么不是形式主义**（活体对照，同一条操作跑两遍）：

| 用哪个工具写 | 跨进程锁 | 改前备份 | 审计账本 |
|---|---|---|---|
| 旧 `memory` | ❌ | ❌ | ❌ |
| 新 `mem_write` | ✅（含与它互操作的 `.memory.lock`） | ✅（`<coreDir>/backups/`） | ✅（`{"k":"write",...}`） |

**它怎么被检查**：`mem_audit` 会在宿主透传工具清单时给出 `[tools.session]`——

- 会话里同时存在 `memory` 与 `mem_*` → ⚠（提示按约定只用 `mem_*`）；
- 会话里只有 `mem_*` → ✓；
- 拿不到清单 → 不出这一项（**不猜**）。

另外 `mem_write` 的工具描述里也写进了这条约定，模型每次调用都会看到。

**它的边界（不假装能强制）**：旧插件的 `memory` 工具无条件注册，本插件**无法禁用**它——所以这是**约定 + 可自检**，不是硬闸门。要硬性只剩它，只能摘掉旧插件的插件行（代价见 §2.1）。

### 8.3 可疑记忆：静默标记 + 延迟裁决（v0.3.1，与用户讨论后拍板）

**动机**：人类记忆不需要"每一步确认"才形成。真正让人记住的是显著性、复述、巩固与**矛盾触发的再巩固**；而错误能被修正，靠的是"再次遇到时的预测误差"。所以本插件把"要不要确认"换成两件事：

1. **写入不打断**（不做逐步确认），但顺手做一次**廉价预检**，把"可能不可靠"**静默**记下来；
2. **只在它再次出现时说话**——写入相似 / 检索命中 / `mem_read` 才提示，提醒对象是**模型**，不是用户。

**判据只看证据，不看是否主流**（这条是硬约束）：

| 理由码 | 判据 | 说明 |
|---|---|---|
| `fragment` | 规范化后短于 `suspectMinChars`（默认 12）或纯标点 | 误触发的典型形态，也是"真噪声"的主要来源 |
| `inferred` | 写入时 `source=agent-inferred` | AI 自己的推断，没有任何外部锚点 |
| `contested` | 与同主题既有条目冲突且无修订标记 | 整理时给**较旧**的那条贴旗（取代提议要人点头，贴旗不用） |
| `lowconfidence` | 写入方主动声明不确定 | 手动 `flag` 用 |

**绝不做的事**：不因为"与主流/共识相悖"就标为可疑。相对论在被接受前确实与当时共识冲突，但它体系完整——本插件对"体系完整但非主流"的观点**不会**命中任何判据（有测试钉着：`isProtectedBody` 与 `isFragmentBody` 对它都为 false）。

**保护性内容永不被标、也不会被"按命中率下沉"**（`protectedKeywords`，默认含 过敏/禁忌/不可逆/合规/红线/法务/凭证/密钥/密码/token 等）。理由：一辈子只说一次却至关重要的信息，若按"没人再提就忽略"处理是灾难。

**标记的存储与到期**：
- 落在 `<coreDir>/suspect.json`（**派生物目录**，不动记忆正本）；
- **内容寻址**：键 = 规范化正文的 sha1 前 16 位 → 正文一改，旧标记自动失效（不需要 TTL）；
- 孤儿标记在 `mem_consolidate(apply)` 时清理；渲染路径保持只读。

**它怎么被看见**：

| 位置 | 表现 |
|---|---|
| 常驻索引 | 索引行带 `⚠?`，页脚一行提示"判据是缺证据，不是与主流相悖"（`suspectInIndex: flag/hide/off`） |
| `mem_search` | 命中的可疑条目带 `⚠?可疑` + 理由 + "据此断言前先核对，或问用户一句" |
| `mem_read` | 给出理由、标记时间、"被再次提到 N 次"与处置建议 |
| `mem_health` | `## 可疑条目（静默标记，不打扰用户但可查）` |
| `mem_audit` | `[suspect.marks]` 判据：规模、理由分布、孤儿数 |

**三种结局**（都不需要人做"删除"决定）：
- 核实通过 → `mem_write(action="verify", track=…, scope=…, match=…)` 清标记；
- 确认是噪声 → 留在原地（不会自动归档，也不占索引的权威性）；
- 与既有结论真冲突 → 走 `supersede`（留档 + 时间线），而不是删除。

**两个诚实的边界**：
1. **"再次提及"不能自我坐实**：`recordMentions` 只记"它又出现了"，**不提升可信度**；而 AI 自己引用自己更是被排除在正向信号之外（否则写错的一条会在几轮里把自己"养成"事实）。
2. **标记本身也可能错**：所以它带理由、可清除、对用户可见（`mem_health`/`mem_audit`），而不是内部黑名单。

### 8.4 整理要用模型吗？花多少 token？

**结论：默认完全不用模型；模型只在"你想让摘要写得更好"时才可选介入。**

| 动作 | 谁来做 | token |
|---|---|---|
| 近重复合并（Jaccard ≥ 0.82） | 本地确定性判定 | **0** |
| 冷条目归档（180 天 + 零命中） | 本地 | **0** |
| 可疑标记（碎片 / 冲突） | 本地启发式 | **0** |
| 日志蒸馏（超期 daily → 长期条目） | **默认：本地机械拼接**（日期 + 各条摘要） | **0** |
| 同上，但用模型重写摘要 | 可选：`apply` 时传 `distilledText` + `model` | 有（按源正文估） |
| 矛盾裁定（哪条是修正后的结论） | 可选：`apply` 时传 `supersede=true` 并由模型判断 | 有 |

> 口径修正（2026-10-28）：上一版文档把"日志蒸馏"写成"需要语义概括 → 有 token"，**这是错的**。
> `buildPlan` 里的蒸馏文本是 **本地机械拼接**（`- 日期 时间 摘要` 逐条列出，受 `DISTILL_TEXT_CAP=1200` 截断），
> 一个 token 都不用。模型的出现只可能来自调用方主动传 `distilledText`。

所以 `mem_consolidate(action="plan")` 会印出来，默认长这样：

```
模型成本：0 token——蒸馏是本地机械拼接（日期 + 各条摘要），合并/归档/可疑标记也都是确定性判定。
只有你想让模型重写摘要（apply 时传 distilledText）或裁定矛盾（supersede=true）时才会用到模型。
```

决定用模型时，它会告诉你**可选成本**（按**源条目正文**算，不是按草案）：

```
模型成本：默认 0 token（机械拼接）。若改为让模型重写摘要/裁定矛盾（distill/supersede），
需要读约 8000 字符 ≈ 5334 tokens（中文 1 token ≈ 1.5 字符保守估）+ 输出不超过 1200 字符/组。
```

**谁来跑模型**：本插件**零依赖、默认不联网**，所以"AI 整理"实际是**会话模型自己**在做（agent 调 plan → 读方案 → 可选传 `distilledText`）。
若要后台用独立小模型，需要新增 opt-in 的 LLM provider 配置（与 `embedding` 同形：默认关闭、显式配置 endpoint/model/key）——目前**没有**实现。

**"用哪个模型"必须可追溯**：传了 `distilledText` 就**必须**同时传 `model`，否则 apply 直接拒绝并说明原因；模型名会记进审计账本（`{"k":"consolidate", "model": "...", "distilled": true}`）。
理由：不同会话可能选不同模型，若不记录，"哪条摘要是哪个模型写的"就成了黑盒，效果不好时无法定点重做。

**成本控制的三个开关**：① 只送候选集（不是全量记忆）；② 蒸馏按"组"分批（一组 = 一个 scope/project 的超期日志）；③ 纯机械动作永远不送模型。

### 8.5 索引分槽：让注入文本「位置稳定」（v0.3.2）

**问题（实测）**：注入块在**系统提示**里，它一变，后面的整段对话历史都无法命中 prefix 缓存。而原来的条目顺序是按「轨道 + mtime」现算的——一条新条目插进中段，后面每一行都错位：

| 场景 | 稳定前缀（两次渲染逐行相同的长度） | 可复用字符 |
|---|---|---|
| 旧行为：每轮按排名/mtime 重排 | **2 / 18 行（11%）** | 74 |
| 分槽后：追加式 | **14 / 18 行（78%）** | **907 / 1109** |

**做法**（借鉴 Codex 的 World State：护缓存的关键不是"发 diff"，而是**结构稳定、值可变**）：

1. **入槽即定序**：条目一旦进槽，位置就固定（不再按排名重排）；
2. **新增只追加**：新条目排到末尾，绝不插队；
3. **超容量只 defer**：容量不够时新条目本轮不进（`deferred` 计数如实给出），**不从中间挖洞**；
4. **内容寻址**：槽位键 = 正文 sha1，文件重排不影响；正文改了才换槽；
5. **定期全量重排**：每 `indexResortEveryHours`（默认 6 小时）一次——那一次会丢缓存，之后就重新稳定（与 Codex「压缩只丢一次」一致）；
6. **统计行挪到页脚**：`条目 N · 本次注入 M · 未注入 K` 每次写入都变，放开头等于每次都改前缀，现在它在末尾。

**配置**：

```yaml
- id: vanwork-memory-core
  config:
    indexStableSlots: true       # 关掉即退回"每轮按排名重排"（旧行为）
    indexResortEveryHours: 6     # 0 = 只在首次/显式失效时重排
```

**取舍（诚实说）**：追加式意味着**新来的高价值条目要等尾部腾位**，不能立刻挤掉中间较弱的条目。这是刻意的——位置稳定的缓存收益大于"立刻最优排序"；没进索引的条目仍可用 `mem_search` 召回，重排周期也会给它机会。

**验证**：`tests/slots.test.js`（15 例）钉住六条性质，其中一条断言"写一条中段轨道的新条目后，**旧条目的行逐字节不变**"。

**重启后一条命令验收**（只读，不写任何记忆或槽位）：

```powershell
& $node scripts/verify-slots.mjs        # 会读你 profile 里的真实配置来验，不是验默认值
```

期望全部 ✅：`槽位文件已生成`（`<coreDir>/index-slots.json`，重启后开个新会话就会出现）、
`统计行在条目区之后`、`同一批条目连渲两次逐字节一致`、`新增一条后旧条目行不变`、`注入未超预算`。

**眼检**：注入块里的 `条目 N · 本次注入 M · 未注入 K` 应该在**底部**（旧版在第二行）；
条目顺序也不是按日期排的——它是槽位顺序，跨轮次不变。

### 8.6 分层压缩：按月打包 + 月摘要（v0.3.3）

**动机**：daily 每天一个文件、每轮都写。一年后 365 个文件；而常驻预算固定——实测已到 **94%~99.9% 占用**，高价值结论被流水挤掉（常见"挤掉 1–2 条"）。

**做法**（借 Codex「Token Budget」的思路：不压缩，改成"分层 + 线索 + 按需下探"）：

| 层 | 位置 | 进常驻索引 | 说明 |
|---|---|---|---|
| **热区** | `daily/YYYY-MM-DD.md` | ✅ | 最近 `dailyHotDays`（默认 30 天）的原文，全文可检索 |
| **温区** | `DIGEST.md`（项目：`projects/<id>/DIGEST.md`） | ✅ | 每月**一条**月摘要：最多 24 条要点 + 指针 |
| **冷区** | `daily/archive/YYYY-MM.md` | ❌（仍可检索） | 整月原文按月打包；归归档轨，`mem_search(includeArchived=true)` 可查 |

**四条硬规则**：

1. **只打包"整月都已过热点期"的月份**——半月打包会让指针与幂等性都变复杂；
2. **保护性内容永不打包**（过敏/禁忌/合规…留在热区），动作里如实报 `protectedKept`；
3. **原文不删**：从日文件"移动"到月文件；只有当天文件被移空才删那个**空**文件；
4. **幂等**：月摘要由"该月条目 + 固定规则"决定；已打包的月份不会再被提出。

**与旧蒸馏的关系**：`monthlyPackEnabled: true`（默认）时**自动跳过**"每日日志蒸馏"——两者都处理超期 daily，同开会重复处理。回旧行为：`monthlyPackEnabled: false`。

**月摘要长这样**（机械生成，0 token；也可用 `distilledText` 让模型写得更好）：

```
月摘要 2025-03 已打包到 daily/archive/2025-03.md，原文仍可检索（mem_search(includeArchived=true)）。
- 02日 第 1 条历史流水… :: daily/archive/2025-03.md#0
- 03日 第 2 条历史流水… :: daily/archive/2025-03.md#1
```

指针序号按**打包后的位置**算，所以 `mem_read("daily/archive/2025-03.md#1")` 能直接命中。

**踩到并修掉的坑（2026-10-28）**：新建的月文件原本没有 `§` 分隔符，`appendEntry` 会沿用"无分隔符 → 换行"的格式保持规则，**3 条打包后并成 1 条**。已把"归档目录里的文件"一并纳入强制 `§` 的规则（`memfile.isDelimiterFile`），并加用例钉住。

**验证**：`tests/pack.test.js`（17 例），含"归档轨不进注入 / 月摘要轨要进注入 / 整月才打包 / 保护内容不打包 / 幂等 / 日文件移空才删 / 与 distill 不重复"。配置：

```yaml
- id: vanwork-memory-core
  config:
    monthlyPackEnabled: true     # 关掉则回到"每日日志蒸馏"
    dailyHotDays: 30             # 热区保留天数
    monthlyPackMinEntries: 3     # 一个月至少几条才成包
    monthlyDigestMaxBullets: 24  # 月摘要要点上限
```

### 8.7 管理界面 + "改得安全"三件套（v0.3.5）

**背景**：旧插件（`dsh-memory-evolve`）被内置更新移除后，记忆 Tab 也跟着没了——记忆只剩"改文件"和"跟 agent 说话"两条路。这一版补上界面，并把"手改会改坏"这件事变可控。

**界面（只做展示与编辑）**：挂在设置页 →「记忆管理」（`settings.section` 槽位）。

| 能力 | 说明 |
|---|---|
| 概览 | 条目数 / 文件数 / 可疑数 / 注入预算（`indexTopN` · `indexMaxChars`） |
| 列表 | 按轨道筛选、只看可疑、按摘要/指针搜索 |
| 编辑 | 载入单条全文 → 改 → 保存（**走锁 + 改前备份 + 修订记录**） |
| 格式体检 | 一键检查结构问题（缺 `§` / 标签未闭合 / 空条目 / 重复 id / 标签粘连正文） |
| 修订记录 | 最近 15 条"谁把哪条从什么改成什么" |
| 核实 | 清掉某条的可疑标记 |

**接口**（宿主半注册，客户端半只负责渲染）：

```
GET  /api/memory-core/state       概览（规模/分轨/预算）
GET  /api/memory-core/entries     列表（?track= & ?suspect=1 & ?q=）
GET  /api/memory-core/entry       单条全文（?ptr=MEMORY.md%230，返回 etag）
POST /api/memory-core/entry       保存 { pointer, base, content } → 冲突返回 409
GET  /api/memory-core/validate    格式体检
GET  /api/memory-core/revisions   最近修订
POST /api/memory-core/verify      清可疑标记
```

**"改得安全"三件套**：

1. **格式体检**（`lib/validate.js`）：手改最常见的破坏是漏 `§`——那不是难看，而是**两条并成一条**。
   检查 `broken-delimiter` / `unclosed-tag` / `empty-entry` / `leading|trailing-delimiter` / `duplicate-id`
   / `inline-tag`（标签不在行首，即上面这种"并成一条"的留痕），
   每条都带"怎么修"。批量版（`validateFiles`）给界面与体检报告用。
2. **乐观并发**：保存时把**"你载入的那份正文"**一起提交；宿主用 `replaceEntry(file, base, content)` ——
   它在**锁内重读**之后才做精确匹配，期间别人改过就匹配不上 → 返回 **409**，绝不覆盖。
3. **逐条修订**（`lib/revisions.js`）：每次改动记 `before/after` 的哈希 + 160 字摘录 + 来源
   （`gui` / `mem_write:replace` / `consolidate`）到 `<coreDir>/revisions.jsonl`（追加式、10MB 轮转）。
   不存全文——全文仍在当天的整份备份里。

**为什么界面编辑也要走闸门**：GUI 若直接 `writeFileSync`，它就变成第三个写者，把锁/备份/账本全绕开。
`POST /entry` 调的是 `replaceEntry`，和 `mem_write` 是同一条路。

**配置**：

```yaml
- id: vanwork-memory-core
  config:
    uiEnabled: true     # 关掉只影响界面，不影响记忆与工具
```

**验证**：`tests/safe-edit.test.js`（20 例）覆盖体检各种坏法、修订记录、路由表（假 req/res 驱动）、
**base 不符时返回 409 且磁盘文件未被覆盖**、以及概览的生成/保存/冲突。

### 8.8 全局概览：一屏看完的「这个 AI 记得我什么」（v0.3.7）

**问题**：正本按**会话 / 日期 / 轨道**分片（`daily/2026-10-28.md`、`projects/<id>/MEMORY.md`…）——
机器友好、人不友好。想知道"它到底记得我什么"得翻几十个条目。

**做法**：生成**一份** `OVERVIEW.md`（观感类似 `AGENTS.md`），分四节：

| 节 | 取自 | 上限 |
|---|---|---|
| 用户（我是谁 / 偏好） | `user` 轨 | 8 |
| 约定与决策（不要被推翻的东西） | **非 daily** 轨 + 命中"约定/决定/不要/必须/只用…" | 8 |
| 当前项目 | `key` 轨 + 本项目条目 | 12 |
| 最近 7 天 | 所有轨 | 10 |

每条都带指针（`:: projects/xxx/MEMORY.md#35`），点开就是原文。

**三条纪律**：
1. **它是派生物**：文件开头写明"改这里不会改原文"；「重新生成」会覆盖整页；
2. **只取舍、不加工**：只挑条目 + 截断摘要，**不改写内容**（改写会造成摘要漂移）；
3. **一条只出现一次**：先被前面小节收走的，后面不重复——否则读者会以为有两件事。

**质量细节（都踩过）**：
- 「约定与决策」**排除 daily 轨**：日志里到处是"约定""决定"，混进来整节就变流水账；
- 摘要去掉开头连续重复的 `[VanWork] [VanWork] ` 前缀；
- 概览是 `overview` 轨，权重 0.98、在 `TRACK_ORDER` 最前——预算紧张时它几乎总能进（一条抵十条）。

**接口**：`GET /api/memory-core/overview`（读现状；`?generate=1` 重新生成）、
`POST /api/memory-core/overview`（保存，带 `base` 做乐观并发）。

### 8.9 编辑交互的修正（v0.3.7）

用户反馈"能看不能编辑"，原因**不是后端**（接口一直通），而是 UI：
"编辑"按钮放在最右列（空表头，被摘要列挤到看不见），而且编辑框出现在列表**下方**——
设置弹窗只有 ~900px 高，等于看不见。

改成：
- **点任意一行即可编辑**（整行 `cursor:pointer`，当前行高亮）；
- 编辑框移到**列表上方**（紧跟概览），保存 / 放弃 / 关闭同一行；
- 概览有自己的编辑框与「重新生成 / 保存 / 放弃 / 重新载入」。

### 8.10 运行时总开关：设置页一键停用（v0.4.2）

**问题**：想让记忆「歇一会儿」（比如嫌简单闲聊也带索引、或排查问题时想要干净上下文），
只能去改 profile 并重启——太重。

**做法**：设置页「记忆管理」面板顶部加了一个「启用记忆」开关。状态落在
`<coreDir>/switch.json`（`{ "enabled": false }`），**不是 profile 配置**——
所以点了立刻生效，不用重启：

| 停用后 | 行为 |
|---|---|
| 常驻索引注入 | 一行都不注入（`renderSnapshotFor` 直接返回 `''`，零上下文成本，也不做轮次记账） |
| `mem_*` 工具 | 仍出现在工具表里（注册是启动期静态的），但每次调用直接返回一行停用说明，不读不写任何文件 |
| 记忆文件 / 索引 / 账本 | **原样保留**，不删不改；重新打开开关即恢复 |
| 管理面板本身 | 照常可用（否则没法再打开） |

三条纪律：
1. **缺文件 = 启用**：开关文件读不到/损坏也按启用处理——开关坏掉不该把记忆整个锁死；
   想强制恢复，删掉 `<coreDir>/switch.json` 即可。
2. **跨进程可见**：每次判定只 `stat` 一下 mtime、变了才重读——web 端点的开关，
   别的会话/上下文下一次渲染就能看到，同时热路径只花一次 statSync。
3. **GUI 编辑不受开关影响**：「修改记忆」走的是管理闸门（锁/备份/修订），不是 `mem_*` 工具面。

接口：`GET /api/memory-core/switch`（读状态）、`POST /api/memory-core/switch`
（`{ "enabled": boolean }`，原子写 + 记账）；`/state` 的返回里也带 `enabled`。

### 8.11 路由注册的真坑：同路径 GET/POST 必须合并（v0.4.3）

**症状**：设置页面板整组 404，desktop.log 里一行
`管理接口注册失败：webserver: duplicate exact route "..."`。

**根因（2026-11-02 用日志钉死）**：宿主的 exact 路由表**按路径判重、不含 HTTP
方法**。`buildRoutes` 里 GET 与 POST 是两条路由，同路径的第二条一注册就抛
duplicate，而且 `mountUi` 的 try/catch 包住的是**整个** `registerRoutes`——
抛错时后面所有路由都没注册。历史日志完全吻合：每天报的都是当时最新的
"GET+POST 同路径"路由（10-28 `/entry` → `/overview`，之后 `/global`，
11-02 `/switch`）。

**连带发现的存量 bug**：0.4.0 / 0.4.1 时代 `POST /global`（「更新记忆」的保存）
**从未注册成功过**——面板显示 GLOBAL.md 一直正常（GET 注册到了），但保存必然
404。此前把"能看不能编辑"归因于按钮位置，只对了一半。

**修法**：`registerRoutes` 按**路径**聚合，同路径的 GET/POST 合并成一个 exact
路由，handler 内按 `req.method` 分发（GET 允许 HEAD 探测，其余 405）。
`buildRoutes` 不变（单测仍按方法驱动）。验证：`tests/switch.test.js` 新增
3 例（路径唯一、按方法分发、405）。

### 8.12 时间戳模式的切块边界：摘要行是条目前缀，不是正文（v0.4.4）

**症状**：`KEY.md` 里同一条的 `[summary:…]` 出现两次；正文行尾直接粘着另一条摘要、
中间没有换行。功能上"读得出来"，但索引里条目 A 的正文**包含了条目 B 的摘要**。

**根因（2026-11-02 用真实文件钉死）**：`buildBody` 把 `[summary:…]` 放在时间戳
**之前**、独占一行；而 `STAMP_RE` 只认时间戳行。于是逐行扫描时：

- 遇到 `[summary:A]` → 不是边界，进 buffer；
- 遇到 `[2026-11-02 …] body1` → 是边界 → **把 summary 单独切成一条**；
- 遇到 `[summary:B]` → 进 buffer，粘在 body1 尾部（缺换行由此而来）。

**为什么模型会把结构写坏**：`mem_read` 读的是正本（没坏），坏的是派生索引
`KEY.md`——恰好是模型定位条目时看的那一份。索引里 A 的正文带着 B 的摘要，
模型拿这段正文当 `match` 去 `replace`，工具侧 `hits.length === 1`，认为匹配
唯一且正确，于是一刀切在了标签行上。**工具缺护栏只是放大器，不是根因**——
先修切块，护栏才有意义。

**修法（四处必须同步，否则索引与写盘错位）**：

1. `scanner.splitIntoEntries`：切分点从"时间戳行"改为"
   **尾部连续标签行 + 时间戳行**"——把 buffer 末尾的纯标签行留（cut）给下一条，
   只把前面的正文切出去。
2. `memfile.readChunks` 的 stamp 分支：用**同一套判定**（`isTagOnlyLine` 由
   `scanner.js` 导出，两处共用）。两处不一致的代价是"索引里的条目"和
   "写盘时切出来的条目"对不上 → `replace` 按索引匹配到 A、却在文件里改写 B。
3. `lib/tools.js`：`replace` / `supersede` 拒绝 `match` 为纯标签行；
   `content` 含行内标签直接拒绝。
4. `lib/validate.js`：新增 `inline-tag`（标签不在行首 = "两条被粘成一条"的留痕）。

**踩过的两个坑**（都是实测打回来的，不是推理出来的）：

- "遇到时间戳时判断 buffer 是否全为标签"——**错的**。那时标签行已经和正文混在
  同一 buffer 里，判断必然失败（当场 2 个用例变红）。正确做法是把尾部标签行
  **cut** 出来，而不是判断。
- `[2026-11-02 14:48] [summary:…]`（时间戳与标签**同行**）是**合法**写法。
  行内标签的判定必须是"前一个**非空白**字符不是 `]`"，写成 `[^\]\n\r]` 不行——
  `[ \t]*` 之前的空格自身会被当成前一个字符，结果把合法写法也拆开（实测拆坏
  `MEMORY.md`）。

**历史数据修复**：`npm run repair:tags`（`scripts/repair-inline-tags.mjs`）
默认 dry-run，`--apply` 才写；拆行 + 去重、改前备份、改后复验、**幂等**。
它只修结构不管语义——摘要内容被改错的条目仍需人工或 `mem_write` 校正。

**验证**：304 个用例全绿；真实损坏文件修复前两侧各 3 chunk 且**一致地错**，
修复后各 2 chunk 且正确。

### 8.13 开发者模式：全部记忆 md 可看可改（v0.6.0）

**问题**：面板只认 `GLOBAL.md` 一份（8.9 的取舍）。但真出问题时（条目结构怪、
`KEY.md` 里两条粘在一起、`daily` 里写错日期），用户只能去文件管理器里翻
`~/.dsh/memories/`——而且**翻到了也不敢改**：不知道哪个文件每轮都注入、
哪个改了下一次就被覆盖。

**做法**：设置页「记忆管理」加第二个开关「开发者模式」，打开后把记忆根下
**全部 `.md`** 列出来，每行带一句话说明"它是干什么的"+ 注入信号灯，点开即
整份查看/编辑。开关状态落 `<coreDir>/devmode.json`（与 8.10 同机制，同样是
点一下立刻生效、跨进程可见）。

五个信号灯（`lib/devfiles.js` 的 `INJECT_KINDS`）：

| 信号 | 含义 | 典型文件 |
|---|---|---|
| 🟢 常驻注入 | 每轮都花上下文预算，改它等于改模型的默认认知 | `GLOBAL.md`、`USER.md`、`projects/*/KEY.md` |
| 🔵 按需检索 | 只进索引，命中才出现 | `MEMORY.md`、`projects/*/MEMORY.md`、`daily/*`、`DIGEST.md` |
| ⚪ 仅留档 | 永不注入，只供追溯（遗忘 = 归档） | `archive/*`、`*-archive.md`、`daily/archive/*` |
| 🟡 派生物 | 改了不改原文，下次生成即覆盖 | `OVERVIEW.md` |
| 🟠 待确认候选 | 不进注入，等被检索命中或人工晋升 | `QUEUE.md` |

**安全默认**（这是本功能最重要的部分）：

1. **缺文件 = 关闭**：升级不会给任何人悄悄装上一个"可写全盘记忆"的入口；
   想开必须显式勾选。损坏的开关文件也按关闭处理。
2. **关闭时后端一律 403**：`/devfile` 的读与写都拒绝，界面拿到的 `files` 是空数组
   （只给 `count` 一个数字）。不是前端藏按钮，是后端不给。
3. **只开放 Markdown**：`.db` / `.jsonl` / `switch.json` 一律 400——索引与账本是
   派生物，改它们只会制造不一致。
4. **路径守卫**：必须落在记忆根内（`guardPath`），`../` 逃逸直接 400。
5. **整份替换必须带 `base`**：没有 `base` 一律 400（拒绝盲写）；`base` 与磁盘当前
   内容不逐字节相同 → 409。这与「条目级编辑」的乐观并发是同一套纪律，只是把
   "匹配一条"换成"匹配整份"。
6. **写入仍走三件套**：改前备份到 `<coreDir>/backups/<date>/`、原子写、记一条修订，
   并立刻 `invalidate` 索引槽（下一轮注入就能看到新内容）。

**它与总开关的关系**：两个开关**互不依赖**。停用记忆 + 开启开发者模式 =
"能翻能改，但不进上下文"（排查记忆质量时的理想状态）；反之则只有 `GLOBAL.md`
可编辑。

接口：`GET/POST /api/memory-core/dev`、`GET/POST /api/memory-core/devfile`
（详见 `lib/api.js` 顶部契约）。**验证**：`tests/dev.test.js` 18 例
（默认关闭 / 关闭时 403 / 清单完整性 / 每个文件都有说明 / 角色判定 /
读写往返 / 409 并发 / 400 越界 / 新建文件 / 关掉立刻恢复拒绝）；全量 412 例全绿。

### 8.14 预建全部记忆文件 + 文件头说明（v0.6.1）

**问题**：记忆根是"用得多了才长出文件"。新装或闲置几天后打开 `~/.dsh/memories/`，
只看到几个文件，看不出"这套记忆本来有哪些轨、各管什么"；`QUEUE.md` 与 `MEMORY.md`
长得一样"像记忆"，实际一个**不进注入**、一个进；`OVERVIEW.md` 更是改了也不生效。

**做法**：`precreateFiles`（**默认开**）在插件装载时幂等补齐应有文件：

| 范围 | 预建 | 不预建（派生物） |
|---|---|---|
| 根目录 | `GLOBAL.md`、`USER.md`、`MEMORY.md`、`QUEUE.md`、`daily/<今天>` | `OVERVIEW.md`、`DIGEST.md`、`*-archive.md`、`archive/*` |
| 已存在的项目目录 | `MEMORY.md`、`KEY.md`、`daily/<今天>` | `DIGEST.md` |

三条纪律：

1. **只写不存在的路径**：已有文件一个字节都不动（`ensureRootLayout` 里每个 `put` 都先 `existsSync`）；
2. **派生物不预建**：`OVERVIEW.md` 一旦预建，`overviewState` 的 `text === ''` 判据就失效
   （面板会直接显示注释而不是自动生成）；`DIGEST` / 归档空文件则会让"有没有归档"这类判据失真。
   它们在开发者模式清单里仍以「未创建」出现；
3. **项目目录只在已存在时补齐**：不凭 cwd 猜项目身份新建目录（猜错就是垃圾目录）。
   打开管理面板时会再补齐一次（`rt.ensureLayout`），所以跨天不用重启也能看到当天的 daily。

**每个文件头部带一句功能说明**（`filedocs.headerNote`），长这样：

```md
<!-- 记忆文件说明（本注释不算记忆内容，可删；删了不影响功能）
MEMORY.md · 全局事实 · 🔵 按需检索
作用：跨项目通用的长期事实与约定（按 § 分条的条目流）。进索引，按相关度被检索或注入。
注意：与 GLOBAL.md 的区别：这里是"全量事实库"，GLOBAL 是"挑出来的那一屏"。
-->
```

**这带来一个必须同时解决的问题：说明注释会被当成一条记忆。** 实测存量 `GLOBAL.md`
的第一条就是 `# 记忆` + 注释块（`track=global`，进常驻注入池，白占预算）——
原来 `ensureRootLayout` 刻意写 0 字节空文件，注释里写的正是"说明性注释会被解析成一个假条目"。

修法是给这类内容一个明确身份：**文件头 = 页眉，不是条目**。

| 层 | 改动 |
|---|---|
| `scanner.splitHeaderComments` | 剥出"开头注释块 + 紧随的一级标题"（`# 记忆`）；**新增旧格式兼容**：`# 标题` 在前、注释紧随其后也算页眉——存量文件一个字节都不用改 |
| `scanner.splitIntoEntries` | 先剥页眉再按 `§` / 时间戳 / 标题切；`isTitleOnlyBlock` **只认一级标题**（`## 待办` 这类分节即使空着也保留，绝不因为"像标题"丢用户内容） |
| `memfile.readChunks` / `joinChunks` | 同样剥页眉、写回时原样拼在最前；`chunks` 用同一份 `isTitleOnlyBlock` 过滤（8.12 的教训：读写两侧必须同一判定） |
| `global.renderSlots` | 注释移到 `# 记忆` **之前**，"更新于"也挪进页眉（原来粘在最后一个槽的正文里） |

效果（真实数据）：`GLOBAL.md` 从 9 条降到 8 条，第一条从 `# 记忆 …` 变成真正的槽
`## 身份`；带说明的空文件仍然是 **0 条目**；`append` 后说明只出现一次、留在最前。

**开发者模式同步升级**：清单里加"应该有但还没有"的占位行（虚线框，点一下即新建），
排序改为**先按目录分组、再按角色**（否则 `projects/<id>/` 会被别的组隔开，
界面会出现两个同名分组标题）。

> ⚠️ **与 `dsh-memory-evolve` 共存时注意**：对方解析记忆文件时不做页眉剥离，
> 会把文件头说明当成"第一条记忆"的正文。本机 profile 已不装载它；若以后要切回去，
> 请把 `precreateFiles` 设为 `false`（只影响新建文件；已有文件里的说明需手工删）。

### 8.15 先流水、后结论：让 daily 真的被写（v0.6.2）

**问题（用户提问引出，账本可证）**：`GLOBAL.md` / `USER.md` 一周没动是正常的（慢变轨），
但**根 `daily/` 从 10-29 起断档 7 天、根 `MEMORY.md` 从未建立**就不正常了。账本给出根因：

```
11-03 起：extract → queue  ×8   （会话边界抽取，按设计只进 QUEUE.md）
11-04   ：add     → key    ×1   （直接写项目结论）
全程     ：add     → daily  ×0   ← 一次都没有
```

不是写入故障，是**写入类型变了**：v0.5.x 的写入纪律只说"落正轨"，而模型把"正轨"
读成 KEY/MEMORY 这类结论轨——流水轨被整条跳过。后果是"结论都在，但'当时试过什么、
排除了什么'永久丢失"，事后既没法复盘，也没法从流水里重新蒸馏结论。

**做法（三层，缺一层就退化成概率游戏）**：

| 层 | 内容 |
|---|---|
| 纪律文本 | `inject.renderWriteRules()` **单一来源**，索引模式与按需检索模式共用同一份（原来两处各写一份、措辞已漂移）。两段写成两个显式步骤 + 点名"别跳过它只写结论"这个具体失败模式 |
| 空库首屏 | `【先写后答】`（仅空库时出现）也改成"先 daily 流水、再结论"——空库是模型最容易照着塑形的时刻 |
| 确定性兜底 | 写结论（`user`/`memory`/`key`）落到正轨时，若**当天该 scope 还没有任何 daily 条目**，`mem_write` 的返回值追加一行：`（今天还没有 daily 流水：先用 … track="daily" … 补一条）`。提示词是概率性的，这一行是确定的，且只在缺口存在时出现（稳态零成本） |

**为什么不自动补写流水**：那会让 daily 变成"结论的回声"，"试过什么"仍然是空的——
流水唯一的价值就是记录**当时的路径**，事后由结论反推出来的东西不算证据。

**两段的门槛必须不同**（否则不叫两段）：`daily` / `project` 免 confirm 直接追加
（`NEEDS_CONFIRM` 只含 `user`/`memory`/`key`），结论轨要 `confirm=true` 才直写正轨、
否则进 `QUEUE.md` 候选。所以第一步没有任何"要不要用户点头"的摩擦，纯靠提示词就能落地。

**配置**：`dailyFirstWrite`（**默认开**）。关掉 = 回退 v0.5.x 措辞，同时兜底提醒也不出现
（提示词与工具行为必须同步回退，否则会出现"提示词不说、工具却催"的分裂感）。

**代价（实测字符数，已尽量收紧）**：

| 注入模式 | 改前 | 改后 | 增 |
|---|---|---|---|
| `pointer`（默认） | 575 | 949 | +374 ≈ 120 token/轮（恒定） |
| `index`（空库） | 884 | 1121 | +237 |

之所以接受：这 120 token 买的是"事后能复盘"，而丢掉的流水**不可再生**。
纪律文本压到 637 字符（原索引模式那一份约 700），靠合并重复句而不是删规则：
"静默"原来在两段里各说一遍，现在只说一遍。

**验证**：450 用例全绿（新增 `tests/daily-first.test.js` 17 例）。真实链路跑一轮：
只写结论 → 工具返回值点出缺口 → 补写流水 → `projects/<id>/daily/<今天>.md` 落盘、
索引里 `[key]` 与 `[daily]` 两条并存、账本两条可查 → 再写结论时提醒消失。

### 8.16 QUEUE 时效归档 + 标签字段名化（v0.7.0）

**问题**：`QUEUE.md` 只有「被检索召回 → 晋升」这一条出口，从不被召回的候选会无限期堆积；
而条目头部的 `[queue:key|project|2e242607bffb]` 是**位置编码**——三个值谁是谁全靠顺序，
`track`（写进哪条轨）与 `scope`（全局 / 项目作用域）本是两个正交维度，挤在一起无法一眼分辨，
新增字段还会静默错位。

**做法**：

| 层 | 改动 |
|---|---|
| 时效 | 新增 `queueStaleDays`（**默认 90 天**，`0` = 关闭，钳制 `0..3650`）。整合 `buildPlan` 增加 3.8 步：超龄且从未被召回 / 复述的候选产生 `queue-expire` 提议 |
| 落地 | `applyPlan` 把候选从 `QUEUE.md` **移入** `QUEUE-archive.md`（移动，不是删除），仍可 `mem_search(includeArchived=true)` 显式召回；账本计数与 `renderPlan` 同步展示 |
| 优先级 | 已被召回的候选走 `promote`，`queue-expire` 不抢同一条（晋升优先于归档） |
| 标签 | 写入侧改为字段名式 `[queue:track=key scope=project id=2e242607bffb]`；`parseQueueBody` 兼容旧的位置式、字段顺序无关，存量数据零迁移成本 |

**一条有意的保留**：`track=project` 没有归一化为 `memory`。project 在这里是**低信任写入**
（`NEEDS_CONFIRM` 不含它，免 confirm 直写）并配合 `source=agent-inferred` 自动标可疑；
归一化会同时抹掉这个语义、并给流水轨凭空加一道确认门槛。曾尝试归一，全量测试 5 例失败后回退。

**验证**：全量用例全绿（新增 `tests/queue-expire.test.js` 3 例、
`tests/parse-queue-body.test.js` 8 例；`tests/session-extract.test.js` 同步覆盖新标签）。

### 8.17 召回与一致性：预取、证据门槛、评测（v0.8.0–0.8.1）

0.8.0 不再扩大工具面，而是补 0.7.0 暴露出的几个缺口：

| 缺口 | 0.8.0 的做法 | 边界 |
|---|---|---|
| pointer 模式"记忆存在但没被用上" | `pointerRecallTopN`（默认 2）每轮自动预取 **global / user / 当前项目 key** 的核心条目；不是全量目录，也不改变"其余按需检索" | 宿主没有把当前用户消息交给注入渲染，所以这不是按 query 的语义召回；它是**核心记忆预取**，不是完整 auto-recall |
| 队列"召回一次就转正"可能放大错误 | `queuePromoteMinHits`（默认 2）：同一候选被召回两次才自动转正；`queue-expire` 跳过保护性关键词 | 仍是启发式；没有置信度/降级 UI |
| 注入形态固定 | `indexMode: 'auto'`：小库（≤`autoIndexMaxEntries`，默认 40）走 index，大库走 pointer，空库走 pointer | 默认仍是 pointer，避免改变既有行为 |
| 没有记忆质量回归 | `npm run eval`：4 个固定查询 + pointer 预取 + 队列证据门槛；`tests/eval-memory.test.js` 纳入全量测试 | 样本小，只用于回归，不是 LongMemEval / LoCoMo |
| 工具名单三处漂移 | `lib/tool-names.js` 单一来源；`mem_audit` 的 `tools.self` 改为读它 | README/docs 的人工表格仍需随版本更新，但代码侧不再三份名单 |

**验证**：476 个用例全绿（新增 `tests/recall-080.test.js`、`tests/eval-memory.test.js`、保护性队列超期 1 例、预取质量 2 例）。GLOBAL 槽位最多预取 1 条并显示槽值；口令/密钥类条目不自动预取。**明确未做**：时序有效性（valid_from/valid_to）、本地嵌入/reranker、daily→结论自动候选、Web 鉴权/静态加密、多设备同步。这些需要 schema 或宿主 API 变更，留到下一版，不用"已支持"措辞。


## 9. 验证（六段证据，全部可复现）

```powershell
$node = "$env:LOCALAPPDATA\Programs\VanWork\resources\runtime\node.exe"
cd C:\Users\cairz01\VanWork\plugins\vanwork-memory-core

# ① 单元测试（304 个 / 13 个文件：扫描/索引/检索/整合/取代/云端/注入/装配/存储接管/锁与审计/配置写入器/可疑标记/索引分槽/分层压缩）
& $node scripts/test-inproc.mjs          # 进程内跑，沙箱可用；结果看 TAP 的 # pass / # fail
#   非沙箱环境可直接：node --test tests/

# ② 端到端自检：造夹具 → 扫描 → 索引 → 检索 → 注入 → 整合 → 云端分层（13 步）
& $node scripts/verify.mjs

# ③ 真实装载：把 DSH 自己的 systemPrompt / tools 服务挂进真实 cordis 树，再挂本插件
& $node scripts/mount-probe.mjs

# ④ 真实 profile 组合：临时 DSH home + 目录联接 + dsh --dump-config
& $node scripts/profile-probe.mjs

# ⑤ 切换安全性（只读真实 profile，在副本上验证禁旧+启新）
$env:DSH_HOME = "<你的 dsh-home>"
& $node scripts/profile-switch-probe.mjs

# ⑥ 跨插件归档契约：用**对方的** ArchiveStore 读回本插件写入的归档
& $node scripts/archive-contract.mjs   # 找不到 dsh-memory-evolve 时如实 SKIP
```

③④ 会自己推断 VanWork 的运行时目录（也可用 `DSH_RUNTIME_APP` 或第一个参数指定），
全程只写系统临时目录，**不碰 `$DSH_HOME/profiles`**。

| 证据 | 证明了什么 |
|---|---|
| ① 476 个用例 | 每个模块的行为与不变量（含 10 个真实踩过的坑的回归：undefined 打挂索引 / 矛盾先于重复 / 归档轨判定 / 归档格式契约 / 陈旧锁回收 / `markSuperseded` 的未定义变量 / 锁参数没透传 / 工具名硬编码 / 摘要行被切成孤立条目 / `inline-tag` 误判合法写法） |
| ② 13 步自检 | 逻辑链路端到端成立（忠实的 ctx 替身） |
| ③ `probe:mount` | **apply 在真实 cordis 树下、拿真实服务跑通**：7 个工具进真实 ToolRuntime、真实 `systemPrompt.assemble()` 里出现 `memory-core:index` 并渲染出真实条目、工具经真实注册表执行能改到真实文件 |
| ④ `probe:profile` | **bundle 解析 + patch 解析成立**：`dsh --dump-config` 组合树里出现 `# == vanwork-memory-core` 与 insert 行，无 skipped bundle 告警 |
| ⑥ `archive-contract` | **对方读得懂我们的归档**：直接 import dsh-memory-evolve 的真 `lib/store.js`，用它的 `ArchiveStore.entriesOf('memory')` 读回本插件写入的 `MEMORY-archive.md` —— 2 条进、2 条出；同时扫描判定 `track=archive`（否则归档会被当成普通记忆重新注入） |
| ⑦ **新会话里的 `mem_audit`** | 运行时事实（不是代码推断）：注入来源、写入面、锁与账本的实际状态 |

> 三个沙箱注意点（都已在脚本里规避）：
> ① 本机禁止 `node --test` 派生子进程（`spawn EPERM`），所以测试用 `scripts/test-inproc.mjs` 在**当前进程内** import 全部用例再 programmatic 执行；
> ② 沙箱禁止跨进程命名管道，所以 `profile-probe` 的子进程输出走**文件描述符**而不是 `stdio: 'pipe'`；调试期实测：同一份代码走脚本文件方式跑 `node:test` 会**静默不执行用例**（退出码恒 0），所以进程内跑法才是可信路径；
> ③ 沙箱下 `Alt+` 之类不存在——本文档命令都用 PowerShell 原生的 `& $node <script>` 形式。

### ④ 的实测输出

```
✅ 插件已以目录联接进入探针 profile 的 node_modules
✅ dsh --dump-config 退出码为 0
✅ 组合树里出现本插件的 bundle 层
✅ 组合树里出现本插件的 insert 行
✅ 无 skipped bundle / 解析告警
✅ bundle 层顺序符合 profile 声明 — # == @deepseek-ai/dsh-base | # == vanwork-memory-core
```

### ③ 的实测输出

```
✅ cordis 树挂载成功（fiber state=2）
✅ 真实 tools 服务挂载（@deepseek-ai/dsh-tools）
✅ 真实 systemPrompt 服务挂载（@deepseek-ai/dsh-system-prompt）
✅ 7 个 mem_* 工具进了真实 ToolRuntime（7/7）
✅ 真实 assemble().contexts 含 memory-core:index
✅ 索引块渲染出真实记忆条目 — 298 字符
✅ 经真实注册表执行 mem_reindex — 索引已刷新（8 ms）
✅ 经真实注册表执行 mem_search 并命中 — 命中 1 条（融合模式 bm25；候选 1）
✅ mem_health 在真实树下可运行并输出云端分层
```

## 10. 目录结构

```
vanwork-memory-core/
├── package.json          # dsh.bundle.patch 声明
├── cordis.patch.yml      # 自动注册（勿在 profile 里重复 insert）
├── lib/
│   ├── index.js          # 插件入口：name / inject / apply
│   ├── config.js         # 默认值（每个默认值都写明取舍）
│   ├── paths.js          # DSH home / 跨设备稳定的项目身份
│   ├── fsutil.js         # 原子写 / 哈希 / 列目录
│   ├── lock.js           # 跨进程文件锁（陈旧回收）
│   ├── ledger.js         # append-only 审计 + 稀疏索引
│   ├── scanner.js        # 多根扫描 + § 条目解析 + CJK 分词
│   ├── indexdb.js        # SQLite FTS5 / 纯 JS 双后端（同一种行形状）
│   ├── retrieve.js       # 混合检索 + RRF + 可解释打分
│   ├── memfile.js        # 记忆文件安全读写（锁 + 备份 + 原子写 + 互操作锁）+ pinned type 校验
│   ├── consolidate.js    # dream：计划 / 指纹 / 应用
│   ├── cloud.js          # 云端分层 + 上云前脱敏
│   ├── inject.js         # 索引常驻注入（预算 + 陈旧 + 自修复 + 会话身份 + 写入交接）
│   ├── audit.js          # 「谁在管存储」的自证报告（mem_audit）
│   ├── tools.js          # 七个 mem_* 工具
│   ├── runtime.js        # 索引生命周期 + 快照缓存 + 每会话轮次/未写计数
│   ├── devfiles.js       # 开发者模式：全部 md 的清点 + 每类文件的功能说明 + 注入信号灯（8.13）
│   ├── api.js            # 管理界面 REST 契约（同一闸门：锁/备份/原子写/修订）
│   └── client.js         # 设置页「记忆管理」面板（总开关 / 开发者模式 / 编辑器）
├── scripts/
│   ├── test-inproc.mjs   # 进程内测试跑法（沙箱可用：绕开 node --test 的子进程）
│   ├── verify.mjs        # 端到端自检（忠实 ctx 替身，13 步）
│   ├── mount-probe.mjs   # 真实 cordis 装载探针（真服务 + 真注册表）
│   ├── profile-probe.mjs # 真实 profile 组合探针（dsh --dump-config）
│   ├── profile-switch-probe.mjs  # 「禁用旧插件 + 启用本插件」的启动安全验证
│   └── archive-contract.mjs      # 跨插件归档格式契约（用对方的 ArchiveStore 读回）
└── tests/                # 26 个测试文件 / 476 个用例
```

## 11. 文档

- **技术文档（记忆怎么存、怎么管、怎么检索）**：[`docs/记忆插件技术文档.md`](docs/记忆插件技术文档.md)
- 取舍矩阵、四家系统对比、**云端存储方案（三条路线对比 + 维护机制 + 合规）**、
  **记忆的删除与修正语义（三级：归档 / 取代 / 销毁）**、决策记录与可行性结论，见
  [`记忆插件设计方案.md`](../../记忆插件设计方案.md)。

---

## 12. 交付与打包（按《DSH 插件开发规范与 TGZ 打包要求》逐项对表）

| 项 | 值 |
|---|---|
| 插件 `name` | `vanwork-memory-core`（规范允许无 scope；若要进内部镜像并希望三级目录，可改为 `@vanwork/dsh-memory-core`） |
| 插件 `version` | `0.8.1`（以 `package.json` 为准） |
| 目标 dsh 版本 | **0.2.0-rc.2** |
| 插件形态 | **Host 半 + Client 半**（`lib/index.js` + `lib/client.js`；设置页「记忆管理」） |
| 注册的插槽 | `settings.section`，`id: vanwork-memory-core`，`order: 35`（不涉及 `sidebar.panellist` / `main` / `plugins.item`，因此 `id == key` 与 `locale` 的约束不适用） |
| 外部依赖 | **无第三方运行时依赖**——只用 `node:` 内建模块（`node:sqlite` 也是内建）。规范第 6 节的**方案 A/B 均不适用**：不需要 `dependencies`，也不需要 vendor `node_modules` |
| Host 入口 | `lib/index.js`（导出 `name` / `inject` / `apply` / `DEFAULTS` / `resolveConfig` / `renderSnapshotFor`） |
| Client 入口 | `lib/client.js`（`window.__ModuleLoader__.load`，`require('react')`） |

### 12.1 `package.json` 的对表与「有意省略」的一项

按规范第 3 节，`peerDependencies` 在本插件上**不适用**，这里写明理由（不是漏写）：

| 字段 | 状态 | 理由 |
|---|---|---|
| `exports` 四项 | ✅ 齐全 | `.` / `./client` / `./cordis.patch.yml` / `./package.json` |
| `dsh.client.inject` / `dsh.client.platform` | ✅ 已声明 | Client 半用到的 `@deepseek-ai/dsh-client-ui-settings`；`platform: "web"` |
| `peerDependencies` / `peerDependenciesMeta` | 省略 | 规范说填「**用到的** `@deepseek-ai/*` 平台包」。本插件**运行时零平台包导入**，与服务（`systemPrompt` / `tools` / `webServer`）交互只走 cordis 的声明式 `inject` 与等待式 `ctx.inject`。凭空声明未使用的 peer 只会让 `evaluatePluginCompatibility` 多一层可失败的校验 |

另：`private: true` 已从原稿**移除**（它只适合本地开发；交付物要能被 `npm pack` / 上架镜像）。
`scripts` 里**没有** `prepare`——规范第 7.2 节担心的「`npm pack` 触发 prepare 导致打包失败」在本插件上不可能发生，因为**没有构建步骤**。

### 12.2 为什么没有 `src/` 与构建配置（按规范第 2 节的「建议」项说明）

本插件的**源码就是 `lib/*.js`**：31 个纯 ESM 模块（30 个 Host 模块 + 1 个 Client 模块）、零转译、零打包。这是刻意的取舍——
规范建议 `src/` + tsdown 是为了便于审计，而「发布的字节 = 审计的字节」在可审计性上更强，
也顺带消掉了规范第 7.2 节点名的 `prepare` 打包陷阱。`files` 已包含 `lib`、`docs`、`scripts`、`tests`
（`scripts/` 与 `tests/` 是可复现验证，`docs/` 是技术文档，一并交付便于复核）。

### 12.3 红线 API 自检（规范第 4.1 节）

对全仓 `*.{js,mjs,json,yml}` 逐条检索，结果：

| 禁用项 | 结果 |
|---|---|
| `sessions.open(id)` | ✅ 无 |
| `sessions.list.getSnapshot().current` | ✅ 无 |
| `import` `dsh-client-runtime` | ✅ 无 |
| 跨插件「值导入」（`import` 别的插件的导出对象） | ✅ 无——**全仓零 `@deepseek-ai/*` 导入**（包括平台包） |
| `ctx.on('session/event')`（session 作用域，全局插件收不到） | ✅ 未使用 |

关于规范第 4.2 节点名的 `ctx.get`：本插件**运行时代码（`lib/`）完全不用 `ctx.get`**，
只用声明式 `inject = ['systemPrompt', 'tools']`（cordis 会等依赖就绪再装载，不会静默失败）。
`ctx.get` 仅出现在 `scripts/mount-probe.mjs`（验证脚本，非插件运行时）。

### 12.4 打包与自检

```powershell
$node = "$env:LOCALAPPDATA\Programs\VanWork\resources\runtime\node.exe"
cd C:\Users\cairz01\VanWork\plugins\vanwork-memory-core

# 1) Host 半可加载（规范第 7 节最小自检）
& $node --input-type=module -e "import('./lib/index.js').then(m=>console.log('host OK', Object.keys(m)))"

# 2) 验证（26 个测试文件 + 端到端 + 真实装载 + 真实 profile 组合 + 切换安全 + 跨插件归档契约）
& $node scripts/test-inproc.mjs
& $node scripts/verify.mjs; & $node scripts/mount-probe.mjs; & $node scripts/profile-probe.mjs
& $node scripts/archive-contract.mjs

# 3) 打包（官方 npm 12 的 npm-cli.js，由 node 直接执行；本机运行时未随附 npm/pnpm）
& $node <npm-cli> pack --ignore-scripts
# 4) sha256
Get-FileHash .\vanwork-memory-core-0.8.1.tgz -Algorithm SHA256
```

> **关于工具链（如实说明）**：VanWork 随附的运行时只有 `node.exe`，没有 npm / pnpm。
> 0.2.0 用当时的 `pnpm pack` 产出；0.8.1 交付使用本机可用的官方 npm CLI 10.9.3 的 `npm-cli.js`
> 直接执行 `npm pack`，产物仍是 npm 原生 tgz（含 `package/` 前缀），满足规范第 7.1 节。
> 该包**没有任何构建步骤**，任何机器上打出的内容都一致（除时间戳）。

### 12.5 配置项（让用户填什么）

只有少量可选项：`injectExclude`（与 `dsh-memory-evolve` 共存时做**注入分工**）、
`legacyLockCompat` / `legacyLockTimeoutMs` / `writeLockTimeoutMs`（写入锁与它的互操作）、
`writeReminder` / `writeReminderAfter` / `writeReminderText`（每轮写入交接提醒）、
`aliasesFile`（会话别名表，默认读对方那份）。其余约 50 项均有合理默认值，
见 `lib/config.js`（每项都写了取舍理由）。完整配置示例见第 4 节。

### 12.6 版本历史

| 版本 | 内容 |
|---|---|
| 0.1.0 | 索引常驻 + 硬预算 + 自修复；BM25 检索（可选向量 + RRF）；整合计划/指纹/备份；云端分层与脱敏；审计账本；六个 `mem_*` 工具 |
| 0.1.x（未独立发布） | 云端分层基线按决策重写（离机仅 `user` 轨）；换用 `mem_health` 的跨设备范围汇总 |
| **0.2.0** | **L2 取代语义**（`[superseded-by]` + 矛盾检测只提议 + 矛盾优先于重复）；**`injectExclude`** 注入分工；规范对表（`files` / `exports` / 去 `private`） |
| 0.2.1 | **归档命名与 memory-evolve 的 `ArchiveStore` 逐字对齐**（`MEMORY-archive.md` / `USER-archive.md` / `projects/<id>/KEY-archive.md`）→ 归档与取代留档在记忆 Tab 归档页**可见、可移回**；归档文件强制 `§` 落盘；`scanner` 把 `*-archive` 归入 `archive` 轨。149 个用例全绿 |
| **0.3.0（首次交付）** | **接管写入编排与注入编排**：① 四个写原语全部进**文件锁**并在锁内重读（`appendEntry`/`removeEntries`/`replaceEntry`/`markSuperseded`），修掉 `markSuperseded` 的未定义 `backupDir`（ReferenceError）、锁参数没透传、备份在锁外读三个真实缺陷；② 新增**与 dsh-memory-evolve 的 `.memory.lock` 互操作**（`legacyLockCompat`），跨插件写同一批文件不再互相覆盖；③ `mem_write` 的 replace/remove/supersede 增加**锁内重校验**（匹配来自快照，落刀前确认目标仍在）；④ 注入补齐**会话身份行**（与对方逐字同款）与**每轮写入交接提醒**（按会话分段、写入归零、只输出阈值布尔）；⑤ 注入文本 `{{…}}` 净化；⑥ 新增 **`mem_audit`**（10 项判据，含 `write.path`：新写入路径是否**真的跑过**、`reminder.state`：提醒为何还在响）；⑦ **外部写入桥接**（`detectExternalWrite`：旧 `memory` 工具/记忆 Tab 写完后未写计数也归零，且绝不拿 `Date.now()` 当基线）；⑧ 写入编排判定口径修正（只看写入路径与让位声明 `exclusiveWritePath`）；⑨ **溢出口径修正**：只有"被预算挤掉"才算溢出并触发 `ACTION REQUIRED`，"按重要性不选中"只给一行说明（实测踩到 39 条注入、剩 448 字符却挂着自修复指令的假警报）；⑩ 新增 `scripts/test-inproc.mjs` 与 `profile-probe` 的用户层配置合并验证。**177 个用例全绿**、`probe:mount` 7/7、`archive-contract` 2/2；**活体已证**：`mem_write` 在运行中的宿主留下 3 条账本 write 记录 + 17955 字节改前备份 |
| 0.3.1 – 0.3.6 | 可疑记忆（内容寻址 + 保护性关键词）、索引分槽（位置稳定，6h 重排）、按月打包 + 月摘要、管理界面（`/api/memory-core/*` 11 条路由 + 设置页「记忆管理」），以及界面 404 的真因修复（`ctx.get('webServer')` 在插件上下文里拿不到） |
| **0.4.0** | **槽位式全局记忆 `GLOBAL.md`**：槽间叠加 / 槽内重写 / 封顶 8 槽 × 80 字，替代"挑选式概览"（改一个槽不影响别的槽、一个槽只有一个当前值、不会逐月膨胀） |
| **0.4.1（本次交付）** | ① 新增 [`docs/记忆插件技术文档.md`](docs/记忆插件技术文档.md)（存储 / 管理 / 检索的完整规则，含全部配置项与故障处置）；② README 第 12 节按 0.4.1 现状重写（Host+Client 形态、插槽、打包工具链）；③ 打包改用官方 `npm@12` 的 `npm pack`；④ 解包后自检（host import / 12 个测试文件 / 端到端 / client 渲染冒烟）。**行为与 0.4.0 一致**，无功能变更 |
| **0.4.2** | **运行时总开关（8.10 节）**：设置页「记忆管理」顶部「启用记忆」开关，状态落 `<coreDir>/switch.json`（缺文件=启用），点击即生效无需重启；停用时注入返回空、`mem_*` 工具调用期拒绝（注册表不动）；新增 `GET/POST /api/memory-core/switch`，`/state` 带 `enabled`。**注：本版本改动因本机命令通道故障未跑回归，重启 VanWork 后应执行 `scripts/test-inproc.mjs`（见第 9 节）** |
| **0.4.3** | **修复路由注册连坐中断（8.11 节）**：宿主 exact 路由按路径判重（不含方法），同路径 GET/POST 分开注册必然在第二条抛 `duplicate exact route` 并中断后续全部注册——0.4.2 当天面板整组 404 即此因；**存量 bug**：0.4.0/0.4.1 的 `POST /global`（面板保存）从未注册成功过。修为按路径聚合、handler 内按方法分发。同样未跑回归（命令通道故障），重启后执行 `scripts/test-inproc.mjs` |
| **0.4.4** | **修复时间戳模式切块把摘要行切成孤立条目（8.12 节）**：`[summary:…]` 是条目前缀（`buildBody` 放在时间戳之前独占一行），但 `scanner.splitIntoEntries` 与 `memfile.readChunks` 两套切块实现都只按 `STAMP_RE` 判边界 → 下一条的摘要被并进上一条末尾且缺换行；**索引里 A 的正文因此"包含"了 B 的摘要**，模型拿索引正文当 `match` 会唯一命中被污染的 A，`replace` 就把结构写坏（工具以为匹配唯一且正确）。修法：① 切分点改为"尾部连续标签行 + 时间戳行"（`isTagOnlyLine`，两模块共用同一判定）；② `mem_write` 的 `replace`/`supersede` 拒绝 `match` 纯标签行、拒绝 `content` 含行内标签；③ `validate` 新增 `inline-tag`；④ 新增 `scripts/repair-inline-tags.mjs`（`npm run repair:tags`，默认 dry-run，`--apply` 才写，改前备份、改后复验、幂等）。**304 个用例全绿**；真实损坏文件切块 3 → 2 且索引侧与写入侧一致 |
| **0.4.5** | **记忆到底有没有被用上：从"感觉"到"数字"**（对照阿里云百炼 Memory 的「观测与审计」与 `min_score`）。① **修一个度量层缺陷**：`mem_search` 原先只在命中时写账本、空查被提前 `return` 抹掉 → **命中率恒为 100%**（幸存者偏差，且发生在度量层，让后续所有"要不要改检索"的判断都失去依据）。改为**先记后返回**，空查与异常一律 `ledger.append('search', {hits, ok, top, filteredByScore})`；口径收敛进新模块 `lib/querylog.js`（纯函数；`hits` 缺失的老记录不计入分母，升级前的账本不污染比率）。② **新增第 9 个工具 `mem_query_log`**：命中率 / 空查簇（重叠度聚类，不是字符串相等——中文换语序 token 集合就会变）/ 平均最高分 / 单查询的分位标定；**只读**。③ **`mem_health` 新增「检索观测」一节**，并在空查率 ≥50% 时明确写"**先别调检索参数**"（通常意味着该记的没记下来，或查询式用了代词）。④ **`searchMinScore` + `searchMinScoreMode`**：`percentile`（丢掉低于本批候选 p75 的，自动随记忆集漂移）或 `absolute`（本机标定过的绝对分）；**默认 0 = 关闭**——百炼的 0.3 不能照抄，因为本插件的 `finalScore = rrf × (0.6+0.4×importance)`，开向量后 rrf 整体上移。过滤在**全池**上做、最后才切 `limit`。未命中文案区分"没召回"与"被门槛砍掉"。⑤ **`scripts/calibrate-search.mjs`**（`npm run calibrate`）：读真实账本，对照命中组/空查组的最高分分布，找"零误杀"门槛并给出可直接粘贴的 YAML；样本 < 20 条时**拒绝给建议**（exit=2 = 再攒几天，不是失败）。⑥ **修 `recencyHalfLifeDays` 装饰性配置**：`retrieve.js` 会读它但 `DEFAULTS` 里没有 → 改这一项此前**完全无效**（0.4.5 补登记 + 钳制 `1..3650`）。⑦ 注入纪律补一句"查询式要自足，不要用代词"。**333 个用例全绿**（13 → 15 个测试文件）；`verify.mjs` / `mount-probe.mjs` / `client-smoke.mjs` 全通过 |
| **0.4.6 → 0.4.8** | **补上"第一轮根本没有入口"这个洞**（S1 实测三轮才定位）。现象：headless 下模型对用户陈述只回"记下了，要不要我记到项目记忆里"，**一次 mem_write 都没调**，后续 2 道回忆题答"没有这条记录"；后几步虽调了工具却不带 confirm，全部落进 `QUEUE.md` 候选（按设计不进常驻索引）→ 命中率 4/6 冻在那儿。排查链：① 0.4.6 加页脚「写入纪律」（`config.writeDiscipline`）→ 队列问题解决（写入落 `MEMORY.md` 正本），首轮仍不写；② 0.4.7 把同一条放到索引首位 → **完全无效，是死代码**（改动在 `renderIndexSnapshot` 里，而调用方空库时已 `return ''`）；③ 0.4.8 找到真根因：`renderSnapshotFor` 里的 `if (entries.length === 0) return ''` —— **空库时一行都不注入**，模型连"有记忆工具"都不知道。改为注入两行空库提示（`config.emptyIndexHint`，默认开，约 60 token，只到第一条记忆落盘为止）。效果：S1 命中 4/6 → **6/6**，延迟 8.3s → 6.8s，名义成本降 33%，19 次工具调用全是 `mem_*`（0 次文件系统旁路）。**339 个用例全绿**（新增 `tests/write-discipline.test.js`；两条断言"空库返回空串"的旧契约按新行为改写，并保留 `emptyIndexHint=false` 的回退用例） |
| **0.6.0** | **开发者模式（8.13 节）**：设置页「记忆管理」新增第二个开关，打开后记忆根下**全部 `.md`** 可整份查看/编辑，每个文件带一句话功能说明 + 注入信号灯（🟢常驻 / 🔵按需 / ⚪仅留档 / 🟡派生物）。**默认关闭**（缺文件=关），关闭时 `/devfile` 读写一律 403 且 `/dev` 不返回清单；只开放 Markdown、路径守卫在记忆根内、整份替换必须带 `base`（缺失 400 / 不匹配 409）、写入仍走备份+原子写+修订+索引失效。两个开关互不依赖。新增 `lib/devfiles.js` 与 `GET/POST /api/memory-core/dev|devfile`。**412 个用例全绿**（新增 `tests/dev.test.js` 18 例；`safe-edit` 的路由条数断言 9→11）|
| **0.6.1** | **预建全部记忆文件 + 文件头说明（8.14 节）**：`precreateFiles` 默认开，装载与打开面板时幂等补齐（root 五个 + 已存在项目三个），只写不存在的路径；每个文件头部带一句功能说明（HTML 注释）并自述角色与注入方式（🟢🔵⚪🟡🟠）。**同时修掉一个存量缺陷**：文件头注释会被当成一条记忆（实测 `GLOBAL.md` 第 1 条 `# 记忆…` 就在常驻注入池里）——新增 `splitHeaderComments`（注释 + 紧随的一级标题 = 页眉，兼容旧的「标题在前」格式），扫描与写入两侧同一判定，`renderSlots` 把注释放到标题之前。开发者模式清单新增「未创建」占位行（虚线框可一键新建）并改为先按目录分组排序。**433 个用例全绿**（新增 `tests/precreate.test.js` 21 例）|
| **0.6.2** | **先流水、后结论（8.15 节）**：`dailyFirstWrite` 默认开。写入纪律文本抽成 `inject.renderWriteRules()` **单一来源**（索引模式与按需检索模式共用），两段写成两个显式步骤：① 有实质进展先 `mem_write(track="daily")` 追加流水（免 confirm）② 结论/决策再写 `key`/`memory`/`user`（confirm=true 才直写正轨），并点名"别跳过它只写结论"。空库首屏 `【先写后答】`、`mem_write` 工具描述、`renderWriteHint` 同步改口径。**确定性兜底**：写结论落到正轨而当天该 scope 还没有 daily 条目时，工具返回值追加一行提示（不自动补写——那会让流水变成结论的回声）。**450 个用例全绿**（新增 `tests/daily-first.test.js` 17 例）|
| **0.8.1（本次交付）** | **预取质量修正**：GLOBAL 槽位不再挤占项目 key（每轮最多 1 条 global），预取显示槽值而不是 `## 槽名`；无日期条目不再输出空 `—  ::`；口令/密钥/凭证类条目不自动预取（仍可 `mem_read` 显式读）。476 用例全绿 |
| **0.8.0** | **召回与一致性**：pointer 核心预取（`pointerRecallTopN` 默认 2，只取 global/user/当前项目 key）；队列证据门槛（`queuePromoteMinHits` 默认 2）与保护性 `queue-expire`；`indexMode:auto`；`npm run eval` 冒烟评测；`lib/tool-names.js` 单一工具名单（audit 的 7 个旧名单修正为 10 个）。474 用例全绿。明确未做：时序有效性、本地嵌入/reranker、daily→结论自动候选、Web 鉴权/加密、多设备同步 |
| **0.7.0** | **QUEUE 时效归档 + 标签字段名化（8.16 节）**：① 新增 `queueStaleDays`（默认 90 天，`0` 关闭）与整合动作 `queue-expire`——超龄且从未被召回的 `QUEUE.md` 候选**移入** `QUEUE-archive.md`（移动非删除，仍可 `mem_search(includeArchived=true)` 召回），晋升优先于归档；② QUEUE 标签由位置式 `[queue:key\|project\|xxx]` 改为字段名式 `[queue:track=key scope=project id=xxx]`，`parseQueueBody` 兼容旧格式且字段顺序无关；③ 明确保留 `track=project` 的低信任写入语义（不归一化为 `memory`）。**465 个用例全绿**（新增 `tests/queue-expire.test.js` 3 例、`tests/parse-queue-body.test.js` 8 例）。同时校正文档里滞后的版本号：第 12 节交付表 `0.4.8` → `0.7.0`，技术文档头部改为「0.4.8 实现基线 + 现行版本以 `package.json` 为准」的如实表述 |

### 12.7 0.4.5 的对照记录：哪些借鉴了、哪些没抄

> 来源文档：[核心概念](https://docs.bailian.console.aliyun.com/zh/model-studio/memory/concepts)、[长期记忆 API](https://docs.bailian.console.aliyun.com/zh/model-studio/long-term-memory-2-0)、[SearchMemory](https://help.aliyun.com/zh/model-studio/memory/search-memory)、[记忆观测](https://help.aliyun.com/zh/model-studio/memory/observation)、[记忆审计](https://help.aliyun.com/zh/model-studio/memory/audit)。

| 百炼的做法 | 我们的处置 | 理由 |
|---|---|---|
| 观测 + 审计双视图（会话 ↔ 记忆变更并排） | **借鉴**（0.4.5 的 ①③） | 我们缺的正是"助手说过的话有没有变成记忆"这个视角，而账本里本来就有数据，只是空查没记 |
| `min_score`（0.3 / 建议 0.5–0.7） | **借鉴概念，不照抄数值**（④⑤） | 绝对分不可移植（RRF 随融合路数漂移）→ 改成分位，并提供本机标定脚本 |
| `messages[]` 入参（能理解代词） | **不引入多轮入参**，改为在注入纪律里要求"查询式自足" | 检索工具是模型主动调用的，一次调用传一段对话会把工具面复杂化；先要求它把话说全 |
| `memory_types`（observation / skill，默认只查 observation） | **暂不做** | 我们的 `track` 已经区分层次（`global/user/memory/project/daily/archive`），再叠一层类型会与 `track` 语义打架；等观测数据显示"日志与结论混检"是真问题再说 |
| 每轮对话后自动抽取写入（`AddMemoryAsync` + 事件轮询） | **不做**（保持显式 `mem_write` + 写入门槛递增） | 自动抽取是"低成本高噪声"的路线；我们的空查率如果高，99% 是"该写的没写"，应该改的是**怎么写**，而不是让机器替用户决定记什么 |
| 记忆库 / 实体 / 项目三层隔离 | **不需要** | 单机单用户；`scope × track` 与 git remote 归一化的 `projectId` 已经覆盖，且比字符串 `project_id` 更强（换 clone 认得出同一个项目） |
| 画像模板（属性清单，未抽取的返回空值） | **待议** | 我们的 `GLOBAL.md` 槽位模型在"一个槽只有一个当前值"上更强；可借鉴的只有"期望槽名清单 → 漏了的显式化"。见技术文档 §3.7 后续 |