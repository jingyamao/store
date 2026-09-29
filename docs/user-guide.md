# 使用指南

项目在本机运行，小说保存在 `books/<书籍 id>/`。需要 Node.js 22 或更新版本。以下命令在项目根目录的 PowerShell 中执行。

## 1. 安装与配置

```powershell
npm install
npm run build
function novel { node dist/cli/index.js @args }
$env:DEEPSEEK_API_KEY = "你的 DeepSeek API Key"
novel config show
```

密钥只放在当前终端环境变量中；不要写进 `novel.config.yaml` 或小说文件。`novel status`、`novel lint`、手写正文、规则体检和搜索不需要密钥。关闭 PowerShell 后若要再次调用模型，需要重新设置环境变量。

## 2. 建书与准备设定

```powershell
novel init my-novel -t "我的小说" -g 玄幻 -p 第三人称有限
novel char add char_linyuan --name "林渊"
novel char set char_linyuan role protagonist
novel plan new ch-0001
novel plan set ch-0001 cast char_linyuan
novel plan set ch-0001 intent "林渊被逐出宗门"
```

编辑 `books/my-novel/style.md` 写文风和禁用词，编辑 `books/my-novel/outline/master.md` 写全书方向。人物、物品、地点、伏笔可用 `novel <集合> add/set/list/show` 管理，也可直接编辑 Bible 的 YAML。

## 3. 写一章

长篇写作建议先用 Agent：

```powershell
novel agent write ch-0001 --dry-run
novel agent write ch-0001
novel adopt <记录 id>
```

`--dry-run` 不需要密钥，会保存分层记忆快照。正式运行会从定稿的旧章节检索相关原文，按目标章节回推已确认的人物状态，规划本章场景，再生成初稿。查看 `runs/<记录 id>/agent-plan.md`、`agent-memory.json`、`context.json`、`draft.md` 和 `run.json` 核对计划、证据、上下文与 token 用量。初稿需要你审阅后采用。写作台「AI 助手」中的「Agent 写初稿」提供相同流程。

历史检索按关键词匹配；请把必须保留的关键事实写进细纲、人物卡或伏笔卡。若早期章节所需人物状态只有后期快照、没有已确认的同步差量，Agent 会隐藏这些动态字段并告警。

传统的分步开篇流程仍可使用：

```powershell
novel write ch-0001 --dry-run
novel write ch-0001 --openings-only
novel runs
```

第二条命令只生成开篇方案。打开 `runs/<记录 id>/openings.md` 读完后，选一个方案续写：

```powershell
novel write ch-0001 --from-run <记录 id> --pick 2
```

初稿保存在同一记录的 `draft.md`。审阅后采用**这份现成的初稿**，不会再次调用模型：

```powershell
novel adopt <记录 id>
novel review ch-0001
novel review ch-0001 --ai
```

`review` 的规则检查免费；`--ai` 会额外调用模型分析文风、节奏和情节。若正文已有内容，`adopt` 会拒绝覆盖；确认替换时用 `--force`。

也可完全手写：

```powershell
novel chapter new ch-0002
novel chapter import ch-0002 draft.txt
```

## 4. 定稿后回写长期记忆

先把正文改成定稿，再运行：

```powershell
novel sync propose ch-0001
novel sync show ch-0001
novel sync apply ch-0001 --accept 1,3 --summary
novel lint
```

提案保存在 `chapters/ch-0001.meta.yaml`，列出状态旧值、新值和正文依据。`--accept` 只应用指定序号；`--summary` 单独确认章节摘要。提案不会自动改 Bible。正文在提案后发生修改时，应用会被拒绝，请用 `novel sync propose ch-0001 --force` 重新提取。若没有状态变化，可以只用 `--summary`。

如果过去的状态或人物关系没有被自动提取，可由作者补录章节历史事实：

```powershell
novel memory record ch-0001 characters char_linyuan state.realm 炼气 --evidence "仍是炼气境"
novel memory show ch-0004 --entity char_linyuan
```

`show ch-0004` 显示第 4 章开始前已确认的事实，不会包含第 4 章及之后的变化。人物关系是完整数组，可用 `--value-file relationships.json` 传入 JSON；同章同字段再次记录需加 `--force`。章节必须已有定稿正文；没有正文原句时用 `--author-note --evidence "作者说明"`。记录位于 `memory/ch-0001.yaml`；引用的正文后来改动后，该条事实会暂时失效并提示重新核对。回写早期章节时，无法确定时间的后期物品、伏笔及人物关系状态会暂时隐藏，可补录早期事实。

不想调用模型时，也能手工写摘要：

```powershell
novel chapter summary new ch-0001
novel chapter summary set ch-0001 summary.txt
```

## 5. 卷摘要（可选）

若写分卷，在每章细纲上设置所属卷；卷结束且章节摘要都已确认后，可压缩卷摘要：

```powershell
novel plan set ch-0001 volume vol-01
novel volume propose vol-01
novel volume show vol-01
novel volume adopt vol-01
```

已采用的卷摘要会进入**后续卷**章节的上下文，不会让同卷早期章节看到未来情节。

## 6. 检索与写作台

```powershell
novel index rebuild
novel search "断岳刀裂痕"
novel ask "断岳刀的裂痕在哪一章出现？"
novel serve
```

浏览器打开命令打印的 `http://127.0.0.1:4173`。左侧选章节，中间写正文并自动保存，右侧可看体检、搜索结果、开篇方案和状态提案。`ask` 会调用模型；`search` 只查本地索引。正文或 Bible 改动较多后，重新运行 `novel index rebuild` 更新索引。

写作台中可以直接新建章节、填写章节标题与细纲、选择出场人物、生成开篇、找回历史初稿，并在阅读全文后决定是否采用。编辑正文会自动保存；切换章节前会先保存未完成的正文。`Ctrl+S` 手动保存，`Ctrl+K` 打开资料检索。顶部的“专注模式”可隐藏两侧面板，正文右上角可调字号。

同一工作区有多本书时，在命令前加 `--book my-novel`。可用 `novel status --all` 列出全部书籍。
