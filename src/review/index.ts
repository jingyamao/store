/** 章节正文体检，规则结果都可定位；AI 评审需显式开启。 */
import { z } from "zod";
import type { ResolvedConfig } from "../config/index.js";
import { loadBible } from "../store/bible.js";
import { chapterNumber } from "../domain/ids.js";
import { parseAiFlavorBlacklist } from "../lint/index.js";
import { createProvider } from "../llm/index.js";
import type { LlmProvider } from "../llm/types.js";
import { loadChapters, readChapterText } from "../store/chapters.js";
import { readTextFileOr } from "../store/file-io.js";
import { readChapterOutline } from "../store/outlines.js";
import { resolveBook } from "../store/paths.js";

export interface ReviewFinding {
  readonly severity: "warning" | "info";
  readonly category: "用词" | "文风" | "节奏" | "情节" | "一致性";
  readonly message: string;
  readonly line?: number | undefined;
  readonly quote?: string | undefined;
}
export interface ReviewResult {
  readonly chapter: string;
  readonly findings: readonly ReviewFinding[];
  readonly metrics: { readonly words: number; readonly paragraphs: number; readonly dialogueRatio: number; readonly averageSentenceLength: number };
  readonly aiUsed: boolean;
}

function lineOf(text: string, fragment: string): number | undefined {
  const index = text.indexOf(fragment);
  return index < 0 ? undefined : text.slice(0, index).split("\n").length;
}
function metrics(text: string): ReviewResult["metrics"] {
  const body = text.replace(/^#{1,6}[^\n]*\n/, "").trim();
  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim() !== "");
  const clean = body.replace(/\s/g, "");
  const sentences = body.split(/[。！？!?]+/).filter((s) => s.trim() !== "");
  const dialogueChars = [...body.matchAll(/[“「『][^”」』]+[”」』]/g)].reduce((sum, hit) => sum + hit[0].length, 0);
  return { words: (clean.match(/[\p{Script=Han}]/gu) ?? []).length, paragraphs: paragraphs.length,
    dialogueRatio: clean.length === 0 ? 0 : dialogueChars / clean.length,
    averageSentenceLength: sentences.length === 0 ? 0 : clean.length / sentences.length };
}

function reviewRules(text: string, style: string, anchors: readonly string[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const word of parseAiFlavorBlacklist(style)) {
    if (text.includes(word)) findings.push({ severity: "warning", category: "用词", message: `命中作者黑名单词「${word}」`, line: lineOf(text, word), quote: word });
  }
  for (const word of ["仿佛", "不禁", "这一刻", "深吸一口气", "眼底闪过"]) {
    const count = text.split(word).length - 1;
    if (count >= 3 && !findings.some((f) => f.quote === word)) findings.push({ severity: "info", category: "用词", message: `「${word}」出现 ${count} 次，建议检查重复感`, line: lineOf(text, word), quote: word });
  }
  const paragraphs = text.replace(/^#{1,6}[^\n]*\n/, "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length >= 6) {
    const lengths = paragraphs.map((p) => p.length);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((sum, len) => sum + (len - mean) ** 2, 0) / lengths.length;
    if (mean > 0 && Math.sqrt(variance) / mean < 0.25) findings.push({ severity: "info", category: "节奏", message: "段落长度过于一致，可检查快慢变化" });
  }
  const current = metrics(text);
  const references = anchors.map(metrics).filter((m) => m.words >= 300);
  if (current.words >= 300 && references.length > 0) {
    const dialogue = references.reduce((sum, m) => sum + m.dialogueRatio, 0) / references.length;
    const sentence = references.reduce((sum, m) => sum + m.averageSentenceLength, 0) / references.length;
    if (Math.abs(current.dialogueRatio - dialogue) >= 0.25) findings.push({ severity: "info", category: "文风", message: `对白占比 ${Math.round(current.dialogueRatio * 100)}%，近期章节约 ${Math.round(dialogue * 100)}%` });
    if (sentence > 0 && Math.abs(current.averageSentenceLength / sentence - 1) >= 0.4) findings.push({ severity: "info", category: "文风", message: `平均句长 ${current.averageSentenceLength.toFixed(1)} 字，近期章节约 ${sentence.toFixed(1)} 字` });
  }
  if (current.words >= 300 && !/[？?！!]|忽然|然而|可是|却|直到|发现|听见|看见/.test(text.trim().slice(-160))) {
    findings.push({ severity: "info", category: "节奏", message: "结尾未发现明显悬念或转折信号；请人工检查章末钩子" });
  }
  return findings;
}

const AiReviewSchema = z.object({ issues: z.array(z.object({ category: z.enum(["用词", "文风", "节奏", "情节", "一致性"]), quote: z.string().min(1), advice: z.string().min(1) })) });
export interface ReviewOptions {
  readonly booksRoot: string;
  readonly bookId?: string | undefined;
  readonly chapter: string;
  readonly ai?: boolean | undefined;
  readonly config?: ResolvedConfig | undefined;
  readonly provider?: LlmProvider | undefined;
}
export async function reviewChapter(options: ReviewOptions): Promise<ReviewResult> {
  const resolved = await resolveBook(options.booksRoot, options.bookId);
  const body = await readChapterText(resolved.paths, options.chapter);
  if (body === undefined || body.trim() === "") throw new Error("章节没有正文，无法体检");
  const chapters = await loadChapters(resolved.paths);
  const number = chapterNumber(options.chapter);
  const anchors = [...chapters.entries()].filter(([id]) => chapterNumber(id) < number)
    .sort((a, b) => chapterNumber(b[0]) - chapterNumber(a[0])).slice(0, 3).map(([, value]) => value);
  const style = await readTextFileOr(resolved.paths.styleFile, "");
  const findings = reviewRules(body, style, anchors);
  const [bible, outline] = await Promise.all([
    loadBible(options.booksRoot, resolved.id), readChapterOutline(resolved.paths, options.chapter),
  ]);
  for (const [open, close] of [["“", "”"], ["「", "」"], ["『", "』"]] as const) {
    const starts = body.split(open).length - 1;
    const ends = body.split(close).length - 1;
    if (starts !== ends) findings.push({ severity: "warning", category: "用词", message: `引号「${open}${close}」数量不匹配：开 ${starts}、闭 ${ends}` });
  }
  const narration = body.replace(/[“「『][^”」』]*[”」』]/g, "");
  if (metrics(body).words >= 300 && bible.book.pov !== "第一人称" && (narration.match(/我/g) ?? []).length >= 4) {
    findings.push({ severity: "info", category: "一致性", message: `本书为${bible.book.pov}，叙述段出现较多「我」；请核对是否发生视角漂移` });
  }
  for (const forbidden of outline?.forbidden ?? []) if (body.includes(forbidden)) {
    findings.push({ severity: "warning", category: "一致性", message: `命中本章细纲禁写内容「${forbidden}」`, line: lineOf(body, forbidden), quote: forbidden });
  }
  for (const character of bible.characters) {
    if (!body.includes(character.name)) continue;
    if (character.state.alive === false && character.state.diedAt !== undefined && chapterNumber(character.state.diedAt) < number) {
      findings.push({ severity: "warning", category: "一致性", message: `已故人物「${character.name}」再次出现；请核对是否为回忆或提及`, line: lineOf(body, character.name), quote: character.name });
    }
    for (const phrase of character.forbidden) if (body.includes(phrase)) {
      findings.push({ severity: "warning", category: "一致性", message: `「${character.name}」的人设禁忌「${phrase}」出现在正文；请人工核对`, line: lineOf(body, phrase), quote: phrase });
    }
    for (const sentence of body.split(/[。！？!?\n]/)) {
      if (!sentence.includes(character.name)) continue;
      for (const realm of bible.powerSystem.realms) {
        if (!sentence.includes(realm.name) || character.state.realm?.includes(realm.name)) continue;
        if (!/(?:已是|已入|晋升|突破|踏入|成为|修为)/.test(sentence)) continue;
        findings.push({ severity: "info", category: "一致性", message: `「${character.name}」在正文被写到「${realm.name}」，Bible 当前为「${character.state.realm ?? "未登记"}」；请核对是否需要回写晋升`, line: lineOf(body, sentence.trim()), quote: sentence.trim() });
      }
    }
    for (const item of bible.items) {
      if (character.state.possession.includes(item.id)) continue;
      const words = [item.name, ...item.aliases].filter((word) => word.length >= 2);
      for (const sentence of body.split(/[。！？!?\n]/)) {
        if (!sentence.includes(character.name) || !/(?:握|拔|持|拿|使用|挥动)/.test(sentence)) continue;
        if (!words.some((word) => sentence.includes(word))) continue;
        findings.push({ severity: "info", category: "一致性", message: `「${character.name}」似乎使用了未登记持有的「${item.name}」；请核对是否为本章新获得`, line: lineOf(body, sentence.trim()), quote: sentence.trim() });
        break;
      }
    }
  }
  if (options.ai === true) {
    if (options.config === undefined) throw new Error("AI 评审需要模型配置");
    const provider = options.provider ?? createProvider(options.config);
    const result = await provider.complete([
      { role: "system", content: "你是中文小说编辑。只报告能在正文中定位的具体问题，尤其是节奏、爽点兑现和文风偏移。只输出 JSON。" },
      { role: "user", content: `输出 {"issues":[{"category":"用词|文风|节奏|情节|一致性","quote":"正文原句","advice":"具体改法"}]}；没有明确问题就用空数组。quote 必须原样出现在正文中。\n文风：${style.slice(0, 3000)}\n设定：${JSON.stringify({ characters: bible.characters.map((c) => ({ name: c.name, state: c.state })), settings: bible.settings.filter((s) => s.immutable), realms: bible.powerSystem.realms }).slice(0, 5000)}\n正文：${body}` },
    ], { model: options.config.llm.utilityModel ?? options.config.llm.model, temperature: 0, maxTokens: 1500 });
    const raw = result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = AiReviewSchema.parse(JSON.parse(raw) as unknown);
    for (const issue of parsed.issues) if (body.includes(issue.quote)) {
      findings.push({ severity: "info", category: issue.category, message: issue.advice, quote: issue.quote, line: lineOf(body, issue.quote) });
    }
  }
  return { chapter: options.chapter, findings, metrics: metrics(body), aiUsed: options.ai === true };
}
