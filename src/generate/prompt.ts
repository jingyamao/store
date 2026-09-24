/**
 * 提示词构造。
 *
 * 系统提示负责「立规矩」，用户提示负责「给料 + 下单」。两者刻意分开：
 *   · 系统提示里没有小说原文，不会被对白中可能出现的「忽略以上指令」污染
 *   · 系统提示短且固定，便于将来做 prompt 缓存
 *
 * 这里的函数都是纯字符串拼装，不查 Bible —— 查库由 run.ts 负责，
 * 于是提示词格式可以被单独测试。
 */

import { chapterNumber } from "../domain/ids.js";
import type { ChapterOutline } from "../domain/outline.js";
import type { LlmMessage } from "../llm/types.js";

/* ── 系统提示 ─────────────────────────────────── */

export interface SystemPromptOptions {
  /** 作者在 style.md 里明确拉黑的词。 */
  readonly blacklist?: readonly string[] | undefined;
  /** 叙述视角，例如「第三人称有限」。 */
  readonly pov?: string | undefined;
}

export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
  const lines: string[] = [
    "你是一位中文网络小说写手，正在与作者协作完成一部长篇连载。",
    "",
    "铁律：",
    "1. 世界观、人物性格、境界等级、持有物、所在地点、伏笔状态，一律以作者提供的设定为准。",
    "   设定与你的直觉冲突时，以设定为准；设定没写的东西，不要自行发明后当成既成事实写。",
    "2. 只写这一章要发生的事。不要提前推进后续情节，也不要替作者收尾。",
    "3. 每个人物的说话方式必须能区分开 —— 口癖、用词习惯、句子长短都应符合其身份与性格。",
    "4. 用具体的动作、对白、细节推进情节，少用概述。不要把情节「汇报」给读者。",
    "5. 章末留钩子，但不要用「欲知后事如何」这类廉价收尾。",
  ];

  if (options.pov !== undefined && options.pov !== "") {
    lines.push(`6. 全章保持${options.pov}视角，不得中途切换。`);
  }

  lines.push(
    "",
    "语言上要避免的毛病：",
    "- 不堆砌排比，不滥用四字成语。",
    "- 不写「这一刻」「仿佛」「不禁」这类万能修饰语。",
  );

  if (options.blacklist !== undefined && options.blacklist.length > 0) {
    lines.push(`- 作者明确拉黑的词，一个都不要出现：${options.blacklist.join("、")}`);
  }

  lines.push(
    "",
    "输出格式：",
    "- 直接输出正文。不要任何解释、说明、点评、总结。",
    "- 不要写章节号或章节标题。",
    "- 不要使用 Markdown 标记（不加 #、*、>、- 等符号）。",
  );

  return lines.join("\n");
}

/* ── 任务段落 ─────────────────────────────────── */

interface TaskInput {
  readonly outline: ChapterOutline;
  readonly targetWords: number;
  readonly povLabel?: string | undefined;
}

function taskLines(input: TaskInput): string[] {
  const { outline } = input;
  const number = chapterNumber(outline.chapter);

  const lines: string[] = ["# 写作任务", ""];
  lines.push(`- 章节：第 ${number} 章`);
  if (outline.title !== "") lines.push(`- 标题：${outline.title}`);
  lines.push(`- 目标字数：约 ${input.targetWords} 字（上下浮动 15% 以内）`);
  if (input.povLabel !== undefined && input.povLabel !== "") {
    lines.push(`- 视角人物：${input.povLabel}`);
  }

  if (outline.intent !== "") {
    lines.push("", "## 本章要达成", outline.intent);
  }
  if (outline.conflict !== "") {
    lines.push("", "## 核心冲突", outline.conflict);
  }
  if (outline.mustInclude.length > 0) {
    lines.push("", "## 必须写到", ...outline.mustInclude.map((entry) => `- ${entry}`));
  }
  if (outline.forbidden.length > 0) {
    lines.push(
      "",
      "## 绝对不要出现",
      ...outline.forbidden.map((entry) => `- ${entry}`),
    );
  }

  return lines;
}

/* ── 初稿提示 ─────────────────────────────────── */

export interface DraftPromptInput extends TaskInput {
  /** 已经渲染好的 Context Pack 文本。 */
  readonly contextText: string;
  /** 作者选定的开篇，作为全章起手。 */
  readonly chosenOpening?: string | undefined;
}

export function buildDraftPrompt(input: DraftPromptInput): string {
  const lines: string[] = [...taskLines(input), ""];

  if (input.chosenOpening !== undefined && input.chosenOpening.trim() !== "") {
    lines.push(
      "## 已选定的开篇",
      "下面这段已经定稿，请直接从它之后续写，不要重复它：",
      "",
      input.chosenOpening.trim(),
      "",
    );
  }

  lines.push(
    "---",
    "",
    "以下是作者提供的全部设定与背景资料。这些是权威事实，严格遵循：",
    "",
    input.contextText,
    "",
    "---",
    "",
    "# 输出要求",
    "",
    `直接输出第 ${chapterNumber(input.outline.chapter)} 章的正文，约 ${input.targetWords} 字。`,
    "不要任何解释、标题或标记。",
  );

  return lines.join("\n");
}

/* ── 开篇提示 ─────────────────────────────────── */

export interface OpeningsPromptInput extends TaskInput {
  readonly contextText: string;
  readonly count: number;
}

export function buildOpeningsPrompt(input: OpeningsPromptInput): string {
  const markers = Array.from(
    { length: input.count },
    (_, index) => `===方案${index + 1}===`,
  );

  return [
    "# 写作任务：开篇方案",
    "",
    `请为下面这一章提供 ${input.count} 个不同的开篇方案。`,
    "",
    "每个方案写 150~250 字，覆盖本章的开头部分。",
    "关键在于「从哪里切入」的角度要明显不同 —— 可以是动作、对白、环境、",
    "心理，也可以从时间线的中间或末尾切入。不要只是换几个词。",
    "",
    ...taskLines({ ...input, targetWords: input.targetWords }),
    "",
    "---",
    "",
    "以下是作者提供的全部设定与背景资料。这些是权威事实，严格遵循：",
    "",
    input.contextText,
    "",
    "---",
    "",
    "# 输出格式",
    "",
    "严格按下面的格式输出，不要有任何额外说明：",
    "",
    markers
      .map((marker) => `${marker}\n（这里写方案正文）`)
      .join("\n\n"),
  ].join("\n");
}

/* ── 开篇解析 ─────────────────────────────────── */

const OPENING_MARKER_RE = /^={2,}\s*方案\s*(\d+)\s*={2,}$/;

/**
 * 解析开篇方案。
 *
 * 模型不按格式输出是常态，所以这里有两层退路：先按标记切，
 * 切不出来就按空行分段。宁可拿到不太规整的方案，也不要因为
 * 格式问题整章失败 —— 那会把一次已经付费的调用白白丢掉。
 */
export function parseOpenings(text: string, expected: number): string[] {
  const found = splitByMarkers(text);
  const cleaned = found.filter((entry) => entry.trim() !== "");
  if (cleaned.length > 0) return cleaned.slice(0, expected);
  return splitByParagraphs(text).slice(0, expected);
}

function splitByMarkers(text: string): string[] {
  const sections: string[] = [];
  let current: string[] | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (OPENING_MARKER_RE.test(line.trim())) {
      if (current !== undefined) sections.push(current.join("\n"));
      current = [];
      continue;
    }
    if (current !== undefined) current.push(line);
  }

  if (current !== undefined) sections.push(current.join("\n"));
  return sections;
}

function splitByParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    // 太短的碎片多半是「好的，以下是三个方案：」之类的客套话
    .filter((chunk) => chunk.length >= 60);
}

/* ── 消息组装 ─────────────────────────────────── */

export function buildMessages(
  systemPrompt: string,
  userPrompt: string,
): readonly LlmMessage[] {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}
