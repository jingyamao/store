/**
 * 章节摘要。
 *
 * 摘要是长程记忆的载体：`recent` 层只能全文覆盖最近 N 章，更早的章节靠
 * 摘要进入上下文。没有摘要，写到第 30 章时模型对第 5 章一无所知。
 *
 * 骨架刻意只问四个问题，每个都对应一类真实会崩的东西：
 * 情节（发生了什么）、状态变化（人物与物品的位移）、伏笔（埋与收）、
 * 遗留（下一章要接住什么）。
 *
 * 标题只写章节名、不重复章节号 —— 注入上下文时 context-pack 会加
 * 【第 N 章摘要】表头，文件里再写一遍纯属浪费 token。
 */

export const SUMMARY_SECTIONS = ["情节", "状态变化", "伏笔", "遗留"] as const;
export type SummarySection = (typeof SUMMARY_SECTIONS)[number];

/** 生成手工写摘要的骨架。`title` 为空时不写标题行。 */
export function scaffoldSummary(title = ""): string {
  const lines: string[] = [];
  const name = title.trim();
  if (name !== "") lines.push(`# ${name}`, "");

  lines.push(
    "### 情节",
    "（这一章发生了什么？3-5 句，只写事实。）",
    "",
    "### 状态变化",
    "- 人物：（谁，从什么变成什么 —— 境界 / 伤势 / 位置 / 持有物）",
    "- 物品：（谁得到了什么，谁失去了什么）",
    "",
    "### 伏笔",
    "- 埋下：",
    "- 回收：",
    "",
    "### 遗留",
    "（本章留下的悬念，下一章开头要接住的事。）",
    "",
  );

  return lines.join("\n");
}

/**
 * 骨架里的空条目：`- 人物：（谁，从什么变成什么）` 剥掉括号说明后只剩标签。
 *
 * 必须先把括号说明剥掉再判断 —— 否则带说明的空条目会被误认为已填内容。
 */
const SCAFFOLD_BULLET_RE = /^[-*]\s*(人物|物品|埋下|回收)\s*[：:]\s*$/;
const PARENTHETICAL_RE = /（[^）]*）|\([^)]*\)/g;

/**
 * 摘要是否只是没填过的骨架（或干脆是空的）。
 *
 * 用来提醒「你建了摘要但没写内容」—— 空摘要进了上下文只会白占 token，
 * 而且会让 `novel status` 谎报「摘要已覆盖」。
 */
export function isSummaryPlaceholder(text: string): boolean {
  const body = text.trim();
  if (body === "") return true;

  const filled = body
    .split("\n")
    .map((line) => line.trim())
    // 括号里的都是写给作者看的提示，不是内容
    .map((line) => line.replace(PARENTHETICAL_RE, "").trim())
    .filter((line) => line !== "")
    .filter((line) => !/^#+\s/.test(line))
    .filter((line) => !SCAFFOLD_BULLET_RE.test(line))
    .join("");

  return filled === "";
}
