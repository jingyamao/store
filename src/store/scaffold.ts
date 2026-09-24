/**
 * 书籍脚手架 —— `novel init` 的实现。
 *
 * 创建完整目录结构，并写入「有指导性的空模板」。
 * 模板本身就是文档：作者打开 style.md 就知道该填什么。
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BOOK_SCHEMA_VERSION, BookSchema, type Book, type Pov } from "../domain/schemas.js";
import { COLLECTION_LIST } from "./collections.js";
import { validate, writeTextFile, writeYamlFile } from "./file-io.js";
import { bookPathsFor, type BookPaths } from "./paths.js";

export interface InitBookOptions {
  readonly bookId: string;
  readonly title?: string;
  readonly author?: string;
  readonly genres?: readonly string[];
  readonly pov?: Pov;
  readonly targetPlatform?: string;
  readonly logline?: string;
  /** 目录已存在时是否覆盖。 */
  readonly force?: boolean;
}

/* ── 模板 ─────────────────────────────────────── */

const STYLE_TEMPLATE = `# 文风锚定

> 这份文档会在生成每一章时被注入上下文，是保证「文风不漂」的基准。
> 抽象形容词（"文笔好""有代入感"）没有用，**具体范例才有用**。
> 请务必填写第五节。

## 一、整体基调

（例：冷硬克制，情绪不直说，靠动作和环境反衬。战斗描写偏短句、重节奏。）

## 二、叙述人称与视角

（例：第三人称有限，始终跟随主角；不进入他人内心。）

## 三、句式偏好

- 句长：（例：以 15–25 字为主，紧张处压到 8 字以内）
- 段落：（例：对话密集处一句一段；描写段不超过 5 行）
- 忌用：（例：不用"仿佛""不禁""这一刻"）

## 四、对白风格

（例：口语化，少用敬语；主角说话带刺；反派不解释动机。）

## 五、正面范例（必填）

> 从你自己的旧作里摘 2–3 段最满意的段落。

\`\`\`
（粘贴你自己的段落）
\`\`\`

## 六、反面范例

> 摘一段你讨厌的、典型"AI 味"的段落，并标注为什么讨厌。

\`\`\`
（粘贴）
\`\`\`

---

## 七、自定义 AI 味黑名单

> 每行一个词/短语。lint 与自检模块会扫描正文中的这些表达。
> 这份清单应当随你写作不断增补 —— 它是本工具最私有的资产。

\`\`\`
仿佛
不禁
这一刻
嘴角勾起
眼底闪过
深吸一口气
\`\`\`
`;

const MASTER_OUTLINE_TEMPLATE = `# 全书总纲

## 一句话简介

（一句话说清：谁，在什么处境下，要做什么，阻力是什么。）

## 核心冲突

（贯穿全书的主线矛盾。）

## 主线脉络

1. 
2. 
3. 

## 主角弧光

（开局是什么样的人 → 结局变成什么样的人，中间的关键转折。）

## 关键伏笔规划

> 每埋一条，就去 \`bible/threads.yaml\` 登记一条。

- 

## 结局设想

（可以不写，但写了能显著提升前期铺垫的质量。）
`;

const POWER_SYSTEM_TEMPLATE = `# 境界 / 等级体系。rules 是硬规则，任何章节都不得违反。
#
# 填写示例：
#   realms:
#     - name: 炼气
#       levels: 9
#       description: 共九层，需引气入体
#     - name: 筑基
#       levels: 3
#   rules:
#     - 越级战斗上限为一个大境界
#     - 突破必须依赖丹药或顿悟，不能靠时间堆积
realms: []
rules: []
`;

const TIMELINE_TEMPLATE = `# 故事内时间线。lint 用于校验事件顺序。
events: []
`;

/* ── init ─────────────────────────────────────── */

function assertBookId(bookId: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(bookId)) {
    throw new Error(
      `非法 book-id: "${bookId}"\n只允许小写字母、数字与连字符，且以字母或数字开头（例：my-novel）。`,
    );
  }
}

/**
 * 创建一本新书。
 *
 * @returns 新书的路径集合
 */
export async function initBook(booksRoot: string, options: InitBookOptions): Promise<BookPaths> {
  const bookId = options.bookId;
  assertBookId(bookId);

  const paths = bookPathsFor(booksRoot, bookId);

  if (existsSync(paths.root) && options.force !== true) {
    throw new Error(
      `书籍目录已存在：${paths.root}\n如需覆盖请加 --force（会重写模板文件，但不会删除你已有的章节）。`,
    );
  }

  // 先建目录
  await Promise.all(
    [
      paths.root,
      paths.bibleDir,
      paths.outlineDir,
      paths.volumesDir,
      paths.chaptersOutlineDir,
      paths.chaptersDir,
      paths.summariesDir,
      paths.runsDir,
    ].map((dir) => mkdir(dir, { recursive: true })),
  );

  const now = new Date().toISOString();
  const book: Book = validate(
    BookSchema,
    {
      schemaVersion: BOOK_SCHEMA_VERSION,
      id: bookId,
      title: options.title ?? bookId,
      author: options.author ?? "",
      genres: [...(options.genres ?? [])],
      targetPlatform: options.targetPlatform,
      pov: options.pov ?? "第三人称有限",
      logline: options.logline ?? "",
      createdAt: now,
      updatedAt: now,
    } satisfies Record<string, unknown>,
    "book.yaml",
  );

  await writeYamlFile(paths.bookFile, book);
  await writeTextFile(paths.styleFile, STYLE_TEMPLATE);
  await writeTextFile(paths.masterOutlineFile, MASTER_OUTLINE_TEMPLATE);
  await writeTextFile(join(paths.bibleDir, "power_system.yaml"), POWER_SYSTEM_TEMPLATE);
  await writeTextFile(join(paths.bibleDir, "timeline.yaml"), TIMELINE_TEMPLATE);

  // 六个实体集合：写空数组 + 各集合自己的说明注释
  for (const def of COLLECTION_LIST) {
    await writeYamlFile(join(paths.root, def.file), { [def.key]: [] }, def.header);
  }

  return paths;
}

/** 判断某路径下是否已经是一本书。 */
export function isBookDir(root: string): boolean {
  return existsSync(join(root, "book.yaml"));
}
