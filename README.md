# novel —— AI 网文创作工作台

> 长篇一致性优先的人机协作写作工具。
> **不提供「一键出全书」** —— 它管的是第 200 章时人物还没崩、伏笔还没忘、境界还没乱。

---

## 为什么不是「一键生成」

生成从来不是瓶颈，模型早就能写出通顺的段落。真实痛点在于写到第 200 章时：

- 人物性格崩了（主角突然变得彬彬有礼）
- 专有名词漂移（「断岳刀」变成「斩岳刀」）
- 境界体系混乱（上一章筑基，这一章没交代就金丹）
- 伏笔挖坑不填（第 7 章埋的裂痕，第 300 章还没解释）
- 已死角色复活

而且平台正在收紧对 AI 痕迹的容忍度，读者对「AI 味」也极度敏感 —— 这两件事直接决定收入。

所以本工具的重心是 **结构化 Story Bible + 强制状态回写 + 确定性一致性校验**，
而不是一个更花哨的 prompt 包装器。

---

## 快速开始

```bash
npm install
npm run build

# 建一本书
node dist/cli/index.js init my-novel -t "我的小说" -g 玄幻 仙侠 -p 第三人称有限

# 也可以直接用源码运行（开发时更方便）
npm run novel -- init my-novel
```

或者用 `--dir` 指向任意工作区（默认是当前目录或 `$NOVEL_HOME`）：

```bash
node dist/cli/index.js --dir D:/我的小说 init my-novel
```

### 日常工作流

```bash
# 1. 先把 style.md 填好 —— 文风锚定是整份 Bible 里最该先填的
#    （它也是 M2 之后每次生成都会注入的上下文）

# 2. 边写边登记
novel char add char_linyuan --name "林渊"
novel char set char_linyuan role protagonist
novel char set char_linyuan state.realm 筑基后期
novel char set char_linyuan state.location loc_luoxiagu
novel char set char_linyuan state.possession '["item_duanyue"]'

# 3. 埋了伏笔立刻登记
novel thread add thread_001 --title "断岳刀的裂痕"
novel thread set thread_001 plantedAt ch-0001

# 4. 随时体检
novel status          # 仪表盘：进度 / Bible 规模 / 伏笔待办
novel lint            # 确定性检查
novel lint --strict   # 警告也视为失败（CI 可用）
```

---

## 命令速查

### 顶层

| 命令 | 说明 |
|---|---|
| `novel init <book-id>` | 创建新书。`-t` 书名、`-a` 作者、`-g` 题材（可多个）、`-p` 视角、`--platform` 平台、`-l` 一句话简介、`-f` 覆盖 |
| `novel status [book-id]` | 仪表盘。`-A/--all` 列出全部书籍、`--no-lint` 跳过 lint 汇总 |
| `novel lint [book-id]` | 确定性检查。`--thread-expiry <n>` 伏笔超期阈值（默认 60 章）、`--strict`、`--rule <name>`、`--json` |

### 全局选项

| 选项 | 说明 |
|---|---|
| `-C, --dir <path>` | 工作区根目录（默认 `$NOVEL_HOME` 或当前目录） |
| `-b, --book <id>` | 指定书籍（默认自动探测；只有一本书时无需指定） |
| `--json` | JSON 输出，便于脚本消费 |

### 六个集合

`characters`（别名 `char`）、`items`（`item`）、`locations`（`loc`）、
`factions`（`faction`）、`threads`（`thread`）、`settings`（`setting`）

每个集合都支持同一套操作：

| 命令 | 说明 |
|---|---|
| `novel <集合> list [-q <关键词>]` | 列表 |
| `novel <集合> show <id>` | 查看 YAML 原文 |
| `novel <集合> add <id> --<主字段> <值>` | 新增（其余字段由 schema 补默认值） |
| `novel <集合> set <id> <路径> <值>` | 按路径改单字段，如 `state.realm 筑基后期` |
| `novel <集合> unset <id> <路径>` | 按路径移除字段 |
| `novel <集合> rm <id>` | 删除，**并报告因此悬空的引用** |

伏笔额外提供：

```bash
novel thread resolve thread_001 --at ch-0042   # --at 省略则用最新一章
```

**路径语法**：`state.realm`、`aliases[0]`、`relationships.0.target`。
值会自动按 JSON 解析，所以 `'["渊哥"]'` 是数组、`123` 是数字、`筑基后期` 是字符串。

---

## 目录约定

```
books/<book_id>/
├── book.yaml                   书籍元信息
├── style.md                    ★ 文风锚定（正面/反面范例 + AI 味黑名单）
├── outline/
│   ├── master.md               全书总纲
│   ├── volumes/vol-01.md       卷纲
│   └── chapters/ch-0001.yaml   细纲（M2 使用）
├── chapters/
│   ├── ch-0001.md              正文
│   └── ch-0001.meta.yaml       元数据 + 状态 delta（M4 使用）
├── bible/                      ← 心脏
│   ├── characters.yaml         人物卡
│   ├── items.yaml              物品
│   ├── locations.yaml          地点
│   ├── factions.yaml           势力
│   ├── power_system.yaml       境界 / 等级体系
│   ├── settings.yaml           已立设定（硬规则）
│   ├── threads.yaml            伏笔追踪
│   └── timeline.yaml           故事内时间线
├── summaries/                  章节 / 卷摘要（M2 使用）
└── runs/                       每次生成的完整记录（M2 使用）
```

**文件即真相。** Bible 全部是 YAML / Markdown，可以直接 `vim` 改、可以 diff、可以用 git 版本化。
数据库（未来的 `index.sqlite`）只做检索索引，随时可重建。

> `books/` 刻意没有被 `.gitignore` —— 每一次设定演进都值得留下历史。

---

## 数据模型

### 一条人物卡长这样

```yaml
- id: char_linyuan
  name: 林渊
  aliases: [渊哥]
  role: protagonist
  firstAppearance: ch-0001
  personality:
    - 表面散漫，实际记仇
    - 对弱者手软
  speechStyle:                    # 对白一致性：口癖是人物辨识度的核心
    patterns: [啧, 有意思]
    register: 冷淡
  relationships:
    - target: char_suwan
      type: 同门
      status: 相互试探
      since: ch-0002
  state:                          # 动态状态：随章节推进而变
    asOfChapter: ch-0087
    realm: 筑基后期
    location: loc_luoxiagu
    possession: [item_duanyue]
    goals: [查明父母死因]
    alive: true
  forbidden:                      # 硬约束：写崩人设时报警
    - 绝不会主动示弱
```

### 伏笔

```yaml
- id: thread_003
  title: 断岳刀的裂痕
  plantedAt: ch-0007
  detail: 刀身出现一道无法修复的裂痕，来源未解释
  status: open                    # open | hinted | resolved | abandoned
  targetResolve: ch-0120
  related: [char_linyuan, item_duanyue]
```

### 一条设计原则

**schema 只管结构正确性，lint 只管内容质量。**

所以 schema 对可选内容保持宽容（手写 YAML 不会因为漏字段就被打回），
缺内容由 lint 温和提醒 —— 主要角色缺字段是 warning，龙套缺字段只是 info。

---

## lint 规则（17 条）

全部是**确定性检查** —— 不需要任何模型调用，毫秒级出结果。

| 类别 | 规则 | 说明 |
|---|---|---|
| 身份 | `duplicate-ids` | 同一集合内 id 重复 |
| | `alias-conflict` | 专名冲突：同集合内是 error，跨集合是 warning |
| | `book-meta-mismatch` | `book.yaml` 的 id 与目录名不一致 |
| 引用 | `dangling-reference` | 关系 / 持有物 / 所在地 / 上级地点 / 伏笔关联 指向不存在的实体 |
| 人物 | `realm-validity` | 境界不在体系中（允许「筑基后期」这类带小层次的写法） |
| | `life-consistency` | `alive` 与 `diedAt` 是否自洽 |
| | `protagonist-count` | 是否恰好一位主角 |
| | `profile-incomplete` | 档案缺口（主要角色 warning，龙套 info） |
| | `possession-conflict` | 同一物品被多人持有 |
| 伏笔 | `thread-expiry` | 未回收且超过阈值（默认 60 章） |
| | `thread-order` | 计划 / 实际回收章节早于埋设章节 |
| | `thread-status` | `resolved` 与 `resolvedAt` 不自洽；未关联实体 |
| 章节 | `chapter-presence` | `firstAppearance` 登记与正文实际出现是否吻合 |
| 项目 | `style-anchor` | `style.md` 是否真正填写（含范例占位符检测） |
| | `master-outline` | 全书总纲是否填写 |
| | `power-system-empty` | 境界体系是否定义 |
| | `empty-bible` | Bible 是否还是白纸 |

**退出码**：`0` 干净；`1` 发现问题（`--strict` 下警告也算）。

---

## 设计原则

1. **一致性优先于生成质量。** 生成质量由模型决定，一致性由系统决定 —— 系统该管后者。
2. **文件即真相。** 可 diff、可 git、可手改。作者随时能绕过 CLI 直接编辑 YAML。
3. **能用规则就别用模型。** 人名一致性、境界校验、死亡角色复现是确定性 lint，
   比 LLM 可靠一个数量级，且免费、毫秒级。模型留给真正需要判断力的事。
4. **人留在环内。** 不提供全自动批量生成。

### 明确不做的事

- ❌ 多用户 / 账号 / 计费
- ❌ 对接起点 / 番茄发布接口
- ❌ 全自动批量生成
- ❌ 云端部署（数据不出本机）

---

## 开发

```bash
npm test           # 84 个测试（Node 内置测试运行器，零原生依赖）
npm run typecheck  # tsc --noEmit
npm run build      # 输出到 dist/
node scripts/e2e.mjs   # 端到端验证（需要先 build）
```

技术栈刻意保持精简 —— 运行时只有 3 个依赖：`zod` / `yaml` / `commander`。

---

## 进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 骨架与数据模型（schema / 读写层 / 脚手架 / CLI） | ✅ 完成 |
| **M1** | Story Bible 管理（CRUD / 伏笔追踪 / 17 条 lint） | ✅ 完成 |
| M2 | 单章生成闭环（Context Pack 组装 / 细纲 → 初稿 / runs 记录） | 待做 |
| M3 | 自检四件套（AI 味检测 / 文风比对 / 爽点体检） | 待做 |
| M4 | 状态回写闭环（AI 抽取 delta / diff 确认） | 待做 |
| M5 | 写作台 UI（三栏布局 / 边写边告警） | 待做 |
| M6 | 检索增强（FTS5 + 向量混合检索） | 待做 |

完整方案见 [`docs/tech-plan.md`](docs/tech-plan.md)。

### 验收标准

> 连续创作 20 章，全程**不手工编辑** `bible/` 下的任何文件，
> 且到第 20 章时系统未报出人物矛盾、境界矛盾或未登记专名。

M2 完成后应当先真实写 5 章验证，再决定是否继续投入。
