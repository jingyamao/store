# AI 网文创作工作台 · 技术方案与 MVP 拆解

> 定位：**个人自用 · 人机协作 · 长篇一致性优先**
> 版本：v0.1 草案
> 日期：2026

---

## 1. 设计原则

| 原则 | 含义 |
|---|---|
| **一致性优先于生成质量** | 生成质量由模型决定，一致性由系统决定。系统该管的是后者。 |
| **文件即真相** | Bible 存为 YAML/Markdown，可 diff、可 git、可手改。数据库只做索引缓存，不是 source of truth。 |
| **能用规则就别用模型** | 人名一致性、境界校验、死亡人物复现——这些是确定性 lint，比 LLM 可靠一个数量级，且免费、毫秒级。 |
| **人留在环内** | 三个必经决策点：定细纲、选开篇、改稿 + 确认状态回写。不提供"一键出全书"。 |
| **状态回写是闭环终点** | 每章写完必须回写 Bible。这一步跳过，Bible 就会腐烂，整个系统失去意义。 |

### 明确不做的事

- ❌ 多用户 / 账号 / 计费
- ❌ 对接起点/番茄发布接口
- ❌ 全自动批量生成（"一键 300 章"）
- ❌ 云端部署（本地跑，数据不出本机）

---

## 2. 核心洞察

现有 AI 写作工具（笔灵、蛙蛙、Sudowrite、NovelCrafter、AutoNovel 等）绝大多数是
**"prompt 包装 + 逐章生成"**，长程一致性普遍做得很糙。

真实痛点不是"写不出来"，而是写到第 200 章时：

- 人物性格崩了（主角突然变得彬彬有礼）
- 专有名词漂移（"断岳刀" → "斩岳刀"）
- 境界体系混乱（上一章筑基，这一章没交代就金丹）
- 伏笔挖坑不填（第 7 章埋的裂痕，第 300 章还没解释）
- 已死角色复活

**本项目的护城河 = 结构化 Story Bible + 强制回写闭环 + 确定性一致性校验。**

---

## 3. 数据模型

### 3.1 目录结构

```
books/<book_id>/
├── book.yaml                    # 书籍元信息、人称、视角、目标平台
├── style.md                     # 文风锚定：作者自述 + 正面/反面范例片段
├── outline/
│   ├── master.md                # 全书总纲
│   ├── volumes/vol-01.md        # 卷纲
│   └── chapters/ch-0001.yaml    # 细纲（本章意图）
├── chapters/
│   ├── ch-0001.md               # 正文
│   └── ch-0001.meta.yaml        # 元数据 + 状态 delta + 体检报告
├── bible/                       # ← 心脏
│   ├── characters.yaml          # 人物卡
│   ├── items.yaml               # 物品
│   ├── locations.yaml           # 地点
│   ├── factions.yaml            # 势力
│   ├── power_system.yaml        # 境界/等级体系
│   ├── timeline.yaml            # 时间线
│   ├── settings.yaml            # 已立设定（硬规则）
│   └── threads.yaml             # 伏笔/线索 ★
├── summaries/
│   ├── ch-0001.md               # 章节摘要（~200 字）
│   └── vol-01.md                # 卷摘要（~600 字）
├── index.sqlite                 # 检索索引（可重建，非真相源）
└── runs/                        # 每次生成的完整记录，可追溯
    └── 20260101-120000-ch0001/
        ├── context.json         # 实际注入的上下文（用于 debug 与复现）
        ├── prompt.txt
        ├── output.md
        └── report.json
```

**为什么用文件：** 自用工具最大优势是作者能直接 `vim bible/characters.yaml` 改东西，
不需要经过 UI。同时 git 天然提供了状态演进历史。

### 3.2 关键 Schema（zod）

```ts
import { z } from "zod";

// ── 人物卡：全书最重要的数据结构 ──────────────────
export const CharacterSchema = z.object({
  id: z.string().regex(/^char_[a-z0-9_]+$/),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  role: z.enum(["protagonist", "deuteragonist", "antagonist",
                "supporting", "cameo"]),
  firstAppearance: z.string(),            // ch-0001

  appearance: z.string().optional(),
  personality: z.array(z.string()).min(1), // 至少一条，防止空卡

  // 对白一致性：口癖是人物辨识度的核心
  speechStyle: z.object({
    patterns: z.array(z.string()).default([]),  // 常说的词
    avoid: z.array(z.string()).default([]),     // 绝不会说的词
    register: z.enum(["文雅", "市井", "粗豪", "冷淡", "跳脱"]).optional(),
  }).default({}),

  relationships: z.array(z.object({
    target: z.string(),                   // char_xxx
    type: z.string(),                     // 同门 / 宿敌 / 暧昧
    status: z.string(),                   // 相互试探
    since: z.string(),                    // ch-0012
  })).default([]),

  // 动态状态：随章节推进而变
  state: z.object({
    asOfChapter: z.string(),
    realm: z.string().optional(),         // 必须能在 power_system 里找到
    location: z.string().optional(),
    injuries: z.array(z.string()).default([]),
    possession: z.array(z.string()).default([]),   // item id
    knownSecrets: z.array(z.string()).default([]),
    goals: z.array(z.string()).default([]),
    alive: z.boolean().default(true),
  }),

  // 硬约束：写崩人设时 lint 报警
  forbidden: z.array(z.string()).default([]),
});

// ── 伏笔追踪：本项目最具差异化的模块 ──────────────
export const ThreadSchema = z.object({
  id: z.string().regex(/^thread_\d+$/),
  title: z.string(),
  plantedAt: z.string(),                  // 埋设章节
  detail: z.string(),
  status: z.enum(["open", "hinted", "resolved", "abandoned"]),
  targetResolve: z.string().optional(),   // 计划回收章节
  payoffNotes: z.string().optional(),
  resolvedAt: z.string().optional(),
  related: z.array(z.string()).default([]),
});

// ── 境界体系：防止等级混乱 ────────────────────────
export const PowerSystemSchema = z.object({
  realms: z.array(z.object({
    name: z.string(),                     // 炼气 / 筑基 / 金丹
    levels: z.number().int().positive().default(1),
    description: z.string().optional(),
  })),
  rules: z.array(z.string()),             // 越级战斗上限：一个大境界
});

// ── 已立设定：硬规则，AI 不得违反 ─────────────────
export const SettingSchema = z.object({
  id: z.string(),
  statement: z.string(),                  // "灵力无法在无月之夜恢复"
  establishedAt: z.string(),
  immutable: z.boolean().default(true),
});
```

**设计取舍：** 字段从最小集开始（`name / personality / state / relationships`），
按需增长。字段设计太全 → 没人填 → Bible 变成空壳。

---

## 4. 生成流水线（人机协作）

```
┌─────────────────────────────────────────────────────┐
│ [人] ① 写本章细纲（意图 / 冲突 / 出场人物 / 要推进的伏笔）│
└──────────────────────┬──────────────────────────────┘
                       ▼
         [系统] 组装 Context Pack（分层 + token 配额）
                       ▼
┌─────────────────────────────────────────────────────┐
│ [AI] 出 3 个开篇方案                                   │
│ [人] ② 选一个 / 自己写开头 / 让 AI 重来               │
└──────────────────────┬──────────────────────────────┘
                       ▼
              [AI] 写正文初稿（分段流式）
                       ▼
        ┌──────────────┴──────────────┐
        ▼                             ▼
  [系统] 确定性 lint            [AI] 软性评审
  · 专名/别名一致性             · AI 味检测
  · 境界体系校验                · 文风比对
  · 死亡人物复现                · 爽点/节奏体检
  · 物品持有校验
  · 视角/人称漂移
        └──────────────┬──────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ [人] ③ 改稿（编辑器旁常驻告警，边写边提示）             │
└──────────────────────┬──────────────────────────────┘
                       ▼
        [AI] 抽取状态 delta（JSON Schema 强约束输出）
                       ▼
┌─────────────────────────────────────────────────────┐
│ [人] ④ 以 diff 形式逐条确认 → 接受 / 拒绝              │
└──────────────────────┬──────────────────────────────┘
                       ▼
   [系统] 合并进 Bible │ 生成章节摘要 │ 更新卷摘要 │ 重跑 lint
```

### 关键约束

- **④ 不可自动化跳过。** 状态回写必须人工确认，否则 Bible 会慢性中毒。
- 但为了不烦人，可以对低风险 delta（如新增一个龙套地点）默认勾选，高风险
  delta（境界变化、人物死亡、关系变质）强制人工确认。

---

## 5. Context Pack 组装（技术核心）

生成第 N 章时该注入什么，直接决定输出质量。

### 分层结构

| 层 | 内容 | 预算占比 | 说明 |
|---|---|---|---|
| L0 恒定层 | `style.md` + 人称/视角 + `forbidden` 硬约束 | ~8% | 每章必带 |
| L1 全局层 | 全书总纲 + 当前卷纲（压缩后） | ~10% | 方向感 |
| L2 近期层 | 前 2–3 章全文 | ~30% | **语感连续性关键** |
| L3 实体层 | 本章出场人物完整卡 + 相关物品/地点 | ~20% | 按细纲里的实体名检索 |
| L4 伏笔层 | 本章相关伏笔 + 长期未回收伏笔提醒 | ~7% | 防挖坑不填 |
| L5 远期层 | 混合检索到的相关历史片段 | ~25% | 按需召回 |

### 检索策略：必须混合，不能纯向量

- **BM25（SQLite FTS5）**：专有名词精确召回。人名、物品名、招式名
  必须能 100% 精确命中——纯向量在这上面很差，这是常见坑。
- **向量（可选，后期）**：语义相关情节召回（"主角第一次杀人的场景"）。
  本地 embedding（如 bge-small）+ `sqlite-vec`，无外部依赖。

### 预算管理

显式实现 `TokenBudget`：每层给配额，超配额时按优先级降级
（全文 → 摘要 → 关键句 → 丢弃）。这个必须显式做，否则一本 300 万字的书根本没法写。

---

## 6. 自检模块

### 6.1 确定性 lint（优先做，性价比最高）

| 检查 | 方法 |
|---|---|
| 专名漂移 | 扫描正文中疑似人名/物品名，比对 Bible 已知名与别名 |
| 未登记人物 | 出现的称呼不在 characters 中 → 提示补登记 |
| 死亡人物复现 | `state.alive === false` 的角色在本章有动作/对白 |
| 境界矛盾 | 正文提到的境界不在 `power_system.realms` 或与 `state.realm` 冲突 |
| 物品持有 | 人物使用了不在 `possession` 里的关键物品 |
| 视角/人称漂移 | 按 `book.yaml` 声明的人称，用正则 + 句法特征检测越界 |
| 引号/标点规范 | 中文引号、省略号、破折号一致性 |
| 伏笔超期 | `status === open` 且距 `plantedAt` 超过 N 章未提及 |

### 6.2 AI 味检测（规则库 + 模型评审）

可检测特征（规则库可增量积累，按自己的文风定制）：

- **高频词黑名单**：仿佛、不禁、这一刻、瞬间、嘴角勾起、眼底闪过、深吸一口气、缓缓地
- **排比密度**：连续 ≥3 个结构相同的短句 → 警告
- **情绪直白解释**：`他感到愤怒` → 应改为动作/生理反应
- **段落长度方差**：方差过小 = 节奏均一（AI 典型特征）
- **对话标签密度**：「……」，他说道 —— 占比过高
- **俗套比喻库**：如"像刀子一样"、"如同一盆冷水"

### 6.3 文风比对

拿 `style.md` + 前 3 章作为 anchor，对比本次初稿的：句长分布、
虚词比例、对话/叙述比、常见句式。输出偏离度，不要求分数漂亮，要求**能定位到具体段落**。

### 6.4 爽点 / 节奏体检

- 结尾是否有钩子（悬念 / 反转 / 新信息）
- 情绪曲线（压抑 → 释放的分布）
- 本章是否有"增量"：境界 / 地位 / 资源 / 信息
- 距上次爽点的章节间隔

---

## 7. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | **TypeScript (Node 22)** | 前后端同构，写作台 UI 需要 |
| 后端 | **Hono** 或 Fastify | 轻，够用 |
| 前端 | **Vite + React** | 三栏写作台 |
| 存储 | **fs（YAML/MD）+ better-sqlite3** | 文件是真相源，SQLite 只做索引 |
| 检索 | **SQLite FTS5**（先） → + sqlite-vec（后） | 零外部依赖 |
| 校验 | **zod** | ★ AI 抽取的 delta 必须过 schema，否则 Bible 会烂 |
| LLM | OpenAI 兼容 SDK | DeepSeek / Kimi / Claude 通吃 |
| 模型分工 | 长文生成用长上下文模型；lint/抽取用便宜快模型 | 成本控制 |

### 写作台 UI 布局

```
┌──────────┬────────────────────────┬──────────────┐
│ 章节树    │  正文编辑器             │  ⚠ 一致性告警 │
│ 大纲      │  （流式生成 / 手写）     │  👤 本章人物卡 │
│ 伏笔看板  │                        │  🎯 爽点体检   │
│          │                        │  🔍 检索面板   │
└──────────┴────────────────────────┴──────────────┘
```

**交互要点：** 不要做成后台批处理。核心体验是「写到某处卡住 → 选中 → 让 AI 续」，
以及「写完一章 → 点一下看体检报告」。

---

## 8. 里程碑

### M0 · 骨架与数据模型（1–2 天）
- Bible 的 zod schema 全套定义
- 目录约定 + 读写层（含版本兼容）
- CLI：`novel init` / `novel status` / `novel lint`

### M1 · Story Bible 管理（2–3 天）
- 人物卡 / 物品 / 设定 / 体系的 CRUD
- **伏笔追踪器**（含"长期未回收"看板）
- 健康检查：跨卡引用失效、别名冲突、id 重复

### M2 · 单章生成闭环（2–3 天）★ 第一个真正的验证点
- Context Pack 组装器（分层 + TokenBudget）
- 细纲 → 三选一开篇 → 初稿
- 生成记录落盘（`runs/`，可复现可 debug）

### M3 · 自检四件套（2–3 天）
- 确定性 lint（先做，最高性价比）
- AI 味规则库
- 文风比对
- 爽点体检

### M4 · 状态回写闭环（2 天）
- AI 抽取 delta（JSON Schema 输出 → zod 校验）
- 人工 diff 确认 UI
- 合并进 Bible + 生成章节/卷摘要 + 重跑 lint

### M5 · 写作台 UI（3–4 天）
- 三栏布局
- 边写边告警
- 检索面板（"苏晚上次出场是什么时候？"）

### M6 · 检索增强（可选）
- FTS5 + 向量混合检索
- 长程情节问答

---

## 9. MVP 范围与验收标准

### MVP = M0 → M4

跑通一次「细纲 → 初稿 → 自检 → 改稿 → 状态回写」的**完整闭环**，
比 UI 漂亮重要得多。CLI + 手工编辑 YAML 完全可以接受。

### 验收标准（可测）

> 连续创作 20 章，全程**不手工编辑** `bible/` 下的任何文件，
> 且到第 20 章时系统未报出人物矛盾、境界矛盾或未登记专名。

过不了这个标准，说明状态管理设计有问题，UI 做得再好也没用。

---

## 10. 风险与取舍

| 风险 | 应对 |
|---|---|
| **过度工程** | Bible 字段从最小集开始，按真实需求长。宁可少字段填满，不要多字段空着 |
| **状态漂移** | 高危 delta 强制人工确认 + 每 10 章做一次全量审计 |
| **Token 成本** | 分层注入 + 摘要压缩；摘要生成用便宜模型 |
| **模型输出脏数据** | 所有结构化输出走 JSON Schema + zod 校验，失败即重试而非写入 |
| **平台政策风险** | 自用定位下风险低；但公开发布时需注意 AI 内容声明要求 |
| **工具本身耗时** | 严格按里程碑走，M2 是第一个"能不能用"的判据，不行就调整方向 |

---

## 11. 下一步

建议直接开 **M0 + M1**：把 Bible 的 schema 和读写层定下来。
这是整个项目的地基，定错了后面全部返工。

M2 完成后立刻做一次真实创作验证（写 5 章），再决定是否继续投入。
