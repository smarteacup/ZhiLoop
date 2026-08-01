import type { EpisodePromptClassification, EpisodePromptContext } from "./types.js";

const CORRECTION = /^(?:不对|不是(?:这个|这样|那样)?(?:意思|方案|实现)?|纠正|更正|应该(?:是|改为)|应当(?:是|改为)|no[,，:]?|correction[:：]?|rather than\b|instead\b)/i;
const NEW_GOAL = /^(?:新的?(?:任务|问题|目标)|换个(?:任务|问题|目标)|另一个(?:任务|问题|目标)|回到\S*|new task\b|new goal\b|switch (?:to|back)\b)/i;
const SUBGOAL = /^(?:另外|同时|还有(?:一个|个)?|除此之外|顺便|补充(?:一点|一个)?|also\b|additionally\b|one more\b)/i;
const CONTINUATION = /^(?:继续|好的?|可以|明白|收到|按这个做|就这样|go on|continue|ok(?:ay)?|sounds good)[。.!！\s]*$/i;

export function classifyEpisodePrompt(
  prompt: string,
  context: EpisodePromptContext,
): EpisodePromptClassification {
  const statement = prompt.trim();
  if (statement.length === 0) throw new Error("user prompt must contain non-whitespace text");
  if (!context.hasEpisode) return { kind: "PRIMARY", statement };
  if (CORRECTION.test(statement)) return { kind: "CORRECTION", statement };
  if (NEW_GOAL.test(statement)) return { kind: "NEW_GOAL", statement };
  if (SUBGOAL.test(statement)) return { kind: "SUBGOAL", statement };
  if (CONTINUATION.test(statement)) return { kind: "CONTINUATION", statement };
  return { kind: "SUBGOAL", statement };
}
