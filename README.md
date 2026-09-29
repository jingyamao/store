# novel —— AI 网文创作工作台

**新工作流与完整命令示例：**[使用指南](docs/user-guide.md)。

**后续产品方向：**[下一阶段建议](docs/next-steps.md)。

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

所以本工具的重心是 **结构化 Story Bible + 分层 Context Pack + 确定性一致性校验**，
而不是一个更花哨的 prompt 包装器。生成当然有，但它只是其中一环 ——
真正决定「第 200 章还能不能看」的是另外两环。

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
#    （它也是每次生成都会最先注入的上下文）

# 2. 边写边登记
novel char add char_linyuan --name "林渊"
novel char set char_linyuan role protagonist
novel char set char_linyuan state.realm 筑基后期
novel char set char_linyuan state.location loc_luoxiagu
novel char set char_linyuan state.possession item_duanyue

# 3. 埋了伏笔立刻登记
novel thread add thread_001 --title "断岳刀的裂痕"
novel thread set thread_001 plantedAt ch-0001

# 4. 随时体检
novel status          # 仪表盘：进度 / Bible 规模 / 伏笔待办
novel lint            # 确定性检查
novel lint --strict   # 警告也视为失败（CI 可用）

# 5. 写一章（详见下文「生成一章」）
novel plan new ch-0001
novel plan set ch-0001 cast char_linyuan,char_suwan
novel plan set ch-0001 intent 林渊被诬陷偷窃灵药，当众逐出宗门
novel write ch-0001 --dry-run    # 先看看会发给模型什么，不花钱
novel write ch-0001              # 真正生成

# 6. 自己写的那几章走这里，不必经过模型
novel chapter new ch-0002        # 建文件直接写
novel chapter import ch-0003 draft.txt   # 导入外部稿子

# 7. 写完立刻补摘要 —— 它也是更早章节进入常规写作上下文的主要途径
novel chapter summary new ch-0001
novel chapter summary set ch-0001 -      # 从标准输入写入
```

---

## 生成一章

### 长篇写作 Agent

已有章节细纲后，推荐用 Agent 写初稿：

```bash
novel agent write ch-0004 --dry-run  # 查看多层记忆，不调用模型
novel agent write ch-0004            # 检索旧章、规划场景、生成初稿
novel adopt <记录 id>                 # 审阅后采用
```

写作台的「AI 助手」也有 **Agent 写初稿** 按钮。Agent 使用全书总纲、卷纲、人物和伏笔卡、近期正文、历史摘要，并从更早的定稿正文中检索与本章相关的段落。记忆按目标章节的时间点组装；已确认的 `sync apply` 状态差量可回推早期人物状态。运行目录额外保存 `agent-plan.md`、`agent-memory.json` 和 `prompt-plan.txt`，可核对规划和每条历史证据的来源。每次模型调用的 token 用量计入 `run.json`。

首次使用前请给章节写清 `intent`、`cast`、`mustInclude` 和相关伏笔。历史检索目前基于关键词匹配；同义改写可能漏检，重要事实应写进人物卡、伏笔卡或细纲。手工修改的后期人物状态若没有同步差量，Agent 会隐藏其动态字段并给出告警，请补录历史状态后再写早期章节。模型上下文窗口仍是有限的，Agent 会按层预算裁剪并在超窗时停止。

如需补齐过去某章的人物境界、关系或伏笔状态，可以记录一条带出处的历史事实：

```bash
novel memory record ch-0001 characters char_linyuan state.realm 炼气 --evidence "仍是炼气境"
novel memory show ch-0004 --entity char_linyuan
```

记录保存在 `memory/ch-0001.yaml`。对应章节必须已有定稿正文；正文依据必须出现在该章定稿中。正文后来修改，旧依据会失效并告警。无法引用正文原句时可用 `--author-note` 标明为作者补录。人物关系数组可通过 `--value-file <JSON 文件>` 输入。回写早期章节时，缺少逐章记录的后期物品、伏笔及人物关系状态会暂时隐藏，需要补录早期事实。

用核对过的章节题目集回归检查历史记忆：

```bash
novel memory evaluate memory-eval.yaml --output memory-eval-report.json
```

题目集格式见[用户指南](docs/user-guide.md)。评测只读本地书籍，不调用模型；若有题目未通过，命令返回退出码 1。真实 30 章题目集需要依据自己的定稿建立。

### 传统分步写作

「人机协作」不是一句口号，它体现在这条命令的默认行为里：

```bash
novel write ch-0001
```

这条命令做三件事，中间有两个由你拍板的决策点：

| 阶段 | 做什么 | 你要做的 |
|---|---|---|
| 1. 组装上下文 | 从 Bible 与近期正文拼出 Context Pack | — |
| 2. 开篇方案 | 让模型给出 3 个不同角度的开篇 | **挑一个**（或信任默认） |
| 3. 全章初稿 | 按选定开篇续写整章 | **决定是否落盘** |

每步的东西都留在 `runs/<时间戳>-<章节>/` 下：`context.json`（完整的
Context Pack）、`prompt.txt`（原样发给模型的提示词）、`openings.md`、
`draft.md`、`run.json`（用量、耗时、告警、自检）。

**初稿默认不会进 `chapters/`。** 它只躺在 `runs/` 里等你看。推荐先只生成开篇、选定后续写，再采用同一份初稿：

```bash
novel write ch-0001 --openings-only
novel write ch-0001 --from-run <记录 id> --pick 2
novel adopt <记录 id>            # 已存在内容时会拒绝覆盖，除非加 --force
novel runs                      # 忘了上次生成到哪了就查这个
```

### 先看看会发给模型什么

```bash
novel write ch-0001 --dry-run
```

只组装上下文并落盘，**不调用模型、不需要密钥、不产生费用**。输出的分层
用量表会告诉你钱花在哪：

```
上下文  548 / 56,000 token  窗口 64,000，预留输出 8,000  ░░░░░░░░░░░░ 1%

层        用量         条目  裁剪
────────  ───────────  ────  ────
文风锚定  363 / 4,480  1     —
全局脉络  129 / 5,600  1     —
本章实体  56 / 12,320  2     —
伏笔线索  0 / 3,920    0     —
近期正文  0 / 16,800   0     —
历史摘要  0 / 12,880   0     —
```

### Context Pack 是什么

这是整个工具的**核心机制**，也是它区别于「prompt 包装器」的地方。

模型没有长期记忆。写到第 200 章时，它对第 7 章埋的那道刀痕一无所知 ——
除非你主动把它放进去。但上下文窗口是有限的，所以这里做两件事：

**一、分层。** 不同性质的信息各有独立预算，互不挤占：

| 层 | 内容 | 默认占比 |
|---|---|---|
| `style` | 文风锚定 + 人物硬性禁忌 | 8% |
| `global` | 全书总纲 + 卷纲 + 境界体系 | 10% |
| `entities` | 本章出场人物的完整状态、相关物品与地点 | 22% |
| `threads` | 本章相关伏笔 + 长期未回收的提醒 | 7% |
| `recent` | 前 N 章全文 —— 语感连续性的关键 | 30% |
| `summaries` | 更早章节的摘要 | 23% |

文风不会被正文挤掉，伏笔不会被人物卡挤掉。

**二、按优先级裁剪。** 预算不够时丢掉最不重要的，而不是随机丢。层内按
优先级稳定排序，所以**同样的输入必然得到同样的 Context Pack** —— 这是
`runs/` 记录可复现的前提。

几个刻意的设计：

- **实体的「当前所在地点」和「持有物」自动带入上下文。** 细纲里只写了
  `cast`，系统会把人物此刻在哪里、手里有什么一并带上 —— 不指望作者每次
  都记得写全，否则模型很容易写出「人在落霞谷却握着留在青云宗的刀」。
- **视角人物优先级高于主角。** 视角决定整章的语感与信息边界。
- **埋得越久的伏笔优先级越高**，超期的会明确标注「已明显超期」。
- **空字段不渲染。** `injuries: []`、`goals: []` 这些纯属浪费 token，
  还会稀释真正有信息量的部分。

预算不够时不会静默降级，而是明确告警：

```
告警
  · 「本章实体」有 2 条因预算不足被整条丢弃
  · 「历史摘要」有 1 条被截断：summaries/ch-0003
```

---

## 自己写，或者把 AI 初稿改到面目全非

正文进入系统**不必经过模型**。这是「自己写小说用」的基本要求 ——
大部分章节你会自己写，或者把 AI 的稿子改得只剩个骨架。

```bash
novel chapter new ch-0007                 # 建文件，直接开始写
novel chapter import ch-0007 draft.txt    # 导入外部稿子
cat draft.txt | novel chapter import ch-0007 -    # 或者走标准输入
novel chapter show ch-0007                # 看正文
novel chapter list                        # 一眼看到哪里断了
```

`novel chapter new` 会读细纲里的标题自动带上，省得每章都敲一遍。
导入时若目标已有正文会拒绝覆盖，并告诉你两边的字数。

### 摘要 —— 长程记忆唯一的载体

这一项值得单独说，因为它是长篇能不能写下去的关键。

模型的上下文窗口是有限的。`recent` 层默认只全文回看最近 **2** 章 ——
写到第 30 章时，模型对第 5 章一无所知，**除非第 5 章有摘要**。

```bash
novel chapter summary new ch-0005      # 生成骨架
novel chapter summary set ch-0005 -    # 从标准输入写入
novel status                           # 看覆盖率
```

摘要不需要文采，只需要准确。骨架刻意只问四个问题，每个都对应一类真实会崩的东西：

| 问题 | 不写会怎样 |
|---|---|
| 情节 | 模型不知道发生过什么，就会重复情节或写出矛盾 |
| 状态变化 | 谁到了哪、伤成什么样、手里拿着什么 —— 写错就是穿帮 |
| 伏笔 | 埋了什么、收了什么，直接决定伏笔会不会被忘掉 |
| 遗留 | 下一章开头要接住什么，断了就是「昨夜」变「三日后」 |

`novel status` 与 `novel chapter list` 都会把缺口点出来：

```
· 摘要覆盖 2/5 章  ← 缺 3 章
· 摘要是更早章节进入模型上下文的唯一途径，缺了它们长程记忆会断
    novel chapter summary new ch-0001
```

**建了骨架但没填内容不算覆盖** —— 系统会识别出来，不会谎报「已覆盖」。
空摘要进了上下文只会白占 token。

> 摘要可以手工写，也可以用 `novel sync propose <章节>` 从定稿提取；后者需用
> `novel sync apply <章节> --summary` 明确确认后才会进入长期记忆。

---

## 配置

```bash
novel config init      # 生成带注释的 novel.config.yaml
novel config show      # 查看当前生效的配置（密钥打码）
```

**密钥不进配置文件。** 配置里只写一个环境变量名：

```yaml
llm:
  baseUrl: https://api.deepseek.com/v1   # 任何 OpenAI 兼容接口都行
  model: deepseek-chat
  apiKeyEnv: DEEPSEEK_API_KEY            # 从哪个环境变量读密钥
```

于是 `novel.config.yaml` 可以安全地提交进 git。

```bash
set DEEPSEEK_API_KEY=你的密钥      # Windows
export DEEPSEEK_API_KEY=你的密钥   # bash
```

换模型不用改代码，改 `baseUrl` 与 `model` 即可 —— Kimi、OpenAI、本地
Ollama 都提供 OpenAI 兼容接口。也可以用环境变量临时覆盖：
`NOVEL_LLM_MODEL`、`NOVEL_LLM_BASE_URL`。

> `write`、`sync propose`、`review --ai` 和 `ask` 会调用模型，需要密钥；
> 其余本地命令不需要密钥。

---

## 命令速查

### 顶层

| 命令 | 说明 |
|---|---|
| `novel init <book-id>` | 创建新书。`-t` 书名、`-a` 作者、`-g` 题材（可多个）、`-p` 视角、`--platform` 平台、`-l` 一句话简介、`-f` 覆盖 |
| `novel status [book-id]` | 仪表盘。`-A/--all` 列出全部书籍、`--no-lint` 跳过 lint 汇总 |
| `novel lint [book-id]` | 确定性检查。`--thread-expiry <n>` 伏笔超期阈值（默认 60 章）、`--strict`、`--rule <name>`、`--json` |
| `novel plan list` | 列出所有已写细纲的章节 |
| `novel plan show <chapter>` | 查看某一章的细纲 |
| `novel plan new <chapter>` | 生成细纲骨架。`-t` 标题、`-f` 覆盖 |
| `novel plan set <chapter> <path> <value>` | 改细纲的单个字段 |
| `novel write <chapter>` | 生成一章初稿。`--dry-run`、`--openings-only`、`--from-run <id>`、`--pick <n>`、`--words <n>` |
| `novel runs` | 查看历史生成记录。`-n/--limit <n>` |
| `novel adopt <run-id>` | 采用已审阅的初稿，不再次调用模型。`-f` 覆盖 |
| `novel review <chapter>` | 规则体检；`--ai` 增加模型评审 |
| `novel sync propose/show/apply <chapter>` | 从定稿提取、查看、逐项确认状态与摘要 |
| `novel volume propose/show/adopt <volume>` | 从所属章节摘要生成、审阅、采用卷摘要 |
| `novel index rebuild` | 重建 SQLite FTS5 检索索引 |
| `novel search <query>` | 搜索正文、摘要、细纲和 Bible |
| `novel ask <question>` | 检索后由模型回答，并列出资料来源 |
| `novel serve` | 启动本地三栏写作台。`-p` 改端口 |
| `novel chapter list` | 章节总览：细纲 / 正文 / 字数 / 摘要 |
| `novel chapter new <chapter>` | 新建正文文件。`-f` 覆盖 |
| `novel chapter show <chapter>` | 查看正文 |
| `novel chapter import <chapter> <file>` | 导入正文，`<file>` 用 `-` 表示标准输入。`-f` 覆盖 |
| `novel chapter summary show <chapter>` | 查看摘要 |
| `novel chapter summary new <chapter>` | 生成摘要骨架。`-f` 覆盖 |
| `novel chapter summary set <chapter> <file>` | 写入摘要，`<file>` 用 `-` 表示标准输入 |
| `novel config show` | 显示当前生效的配置（密钥打码） |
| `novel config init` | 生成带注释的 `novel.config.yaml`。`-f` 覆盖 |

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

**值的写法**：先按 JSON 解析，所以 `123` 是数字、`筑基后期` 是字符串。
数组字段（`aliases` / `cast` / `mustInclude` …）额外支持**不加引号的
逗号列表**：

```bash
novel char set char_linyuan aliases 渊哥,林小子
novel plan set ch-0001 cast char_linyuan,char_suwan
```

这条兜底不是可有可无的便利 —— Windows PowerShell 5.1 向原生命令传参时
会吃掉内层双引号，`'["渊哥"]'` 到了进程里变成 `[渊哥]`，JSON 直接解析
失败。与其让你去背转义规则，不如让朴素写法也能用。兜底只在 schema 期望
数组时触发，所以 `intent "先铺垫，再爆发"` 这类含逗号的普通文本不受影响。

写错字段名会直接报错，不会被静默忽略：

```
$ novel plan set ch-0001 casts x
casts 没有写入 —— 这个字段不存在，多半是名字拼错了。

可用字段见：novel plan show ch-0001
```

---

## 目录约定

```
books/<book_id>/
├── book.yaml                   书籍元信息
├── style.md                    ★ 文风锚定（正面/反面范例 + AI 味黑名单）
├── outline/
│   ├── master.md               全书总纲
│   ├── volumes/vol-01.md       卷纲
│   └── chapters/ch-0001.yaml   章节细纲 ← M2 使用
├── chapters/
│   ├── ch-0001.md              正文
│   └── ch-0001.meta.yaml       待确认状态提案与应用记录
├── bible/                      ← 心脏
│   ├── characters.yaml         人物卡
│   ├── items.yaml              物品
│   ├── locations.yaml          地点
│   ├── factions.yaml           势力
│   ├── power_system.yaml       境界 / 等级体系
│   ├── settings.yaml           已立设定（硬规则）
│   ├── threads.yaml            伏笔追踪
│   └── timeline.yaml           故事内时间线
├── summaries/                  已确认的章节摘要
├── index.sqlite                可重建的 FTS5 检索索引
└── runs/                       每次生成的完整记录 ← M2 使用
    └── 20250101-120000-ch-0001/
        ├── context.json        完整的 Context Pack（含裁剪详情）
        ├── prompt.txt          原样发给模型的提示词
        ├── prompt-openings.txt 开篇阶段的提示词
        ├── openings.md         三个开篇方案
        ├── draft.md            初稿
        └── run.json            用量、耗时、告警、自检
```

**文件即真相。** Bible 全部是 YAML / Markdown，可以直接 `vim` 改、可以 diff、可以用 git 版本化。
`index.sqlite` 只做检索索引，随时可用 `novel index rebuild` 重建。

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
4. **人留在环内。** 不提供全自动批量生成，而且这不只是口号 ——
   它体现在默认行为里：初稿默认不落盘、开篇方案要你挑、
   状态回写（M4）必须经你确认。默认路径就是需要你点头的路径。
5. **每一次生成都留痕。** `runs/` 里存着当时完整的上下文、原样的提示词、
   用量与耗时。生成结果不对劲时，能精确复盘「当时到底发了什么」——
   而不是靠回忆和猜测。

### 明确不做的事

- ❌ 多用户 / 账号 / 计费
- ❌ 对接起点 / 番茄发布接口
- ❌ 全自动批量生成
- ❌ 云端部署（数据不出本机）

---

## 开发

```bash
npm test           # Node 内置测试运行器，零原生依赖
npm run typecheck  # tsc --noEmit
npm run build      # 输出到 dist/
node scripts/e2e.mjs   # 端到端验证，26 段断言（需要先 build）
```

技术栈刻意保持精简 —— 运行时只有 3 个依赖：`zod` / `yaml` / `commander`。
没有厂商 SDK，模型调用就是一个内置 `fetch`。

---

## 进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 骨架与数据模型（schema / 读写层 / 脚手架 / CLI） | ✅ 完成 |
| **M1** | Story Bible 管理（CRUD / 伏笔追踪 / 17 条 lint） | ✅ 完成 |
| **M2** | 单章生成闭环（Context Pack / 细纲 → 开篇 → 初稿 / runs 记录） | ✅ 完成 |
| **M3** | 规则体检、文风统计、可选 AI 节奏评审 | ✅ 完成 |
| **M4** | 状态提案、逐项确认回写、章节与卷摘要提取 | ✅ 完成 |
| **M5** | 本地三栏写作台、自动保存与告警 | ✅ 完成 |
| M6 | SQLite FTS5 全文检索与检索问答 | 已实现；向量检索仍为可选扩展 |

写作台使用 Node 本地 HTTP 服务和原生页面，保持运行时依赖精简；技术方案初稿中
的 React/Vite 选型未采用。写作流程与数据格式不依赖界面实现。

完整方案见 [`docs/tech-plan.md`](docs/tech-plan.md)。

### 验收标准

> 连续创作 20 章，全程**不手工编辑** `bible/` 下的任何文件，
> 且到第 20 章时系统未报出人物矛盾、境界矛盾或未登记专名。

M2 已完成，且补上了「手写正文 / 手写摘要」这条不经过模型的通路 ——
没有它，工具就只是个模型前端，而不是写作工具。

**下一步建议真实写 5 章**，检查状态提案的误报、漏报和长程检索命中率。
每章定稿后确认摘要和状态变化，再写下一章。
