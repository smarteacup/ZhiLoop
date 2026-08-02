import type { ConfirmationOption, ConfirmationRequest } from "@zhiloop/domain";

export type ConfirmationMatch =
  | { readonly status: "NO_MATCH" }
  | { readonly status: "AMBIGUOUS" }
  | { readonly status: "MATCH"; readonly option: ConfirmationOption; readonly responseKind: "OPTION" | "CORRECTION" };

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\p{P}\p{S}\s]+/gu, "").trim();
}

const PHRASES: Readonly<Record<string, readonly RegExp[]>> = {
  KEEP_PROPOSED: [/^(?:暂不处理|先保留候选|保持候选)$/u],
  REJECT_CANDIDATE: [/^(?:拒绝|拒绝候选|不采用|不接受|否定候选|不要这个候选|不是这个意思)$/u],
  ACCEPT_CANDIDATE: [/^(?:采用|采用候选|接受候选|同意采用|就用这个)$/u],
  KEEP_PROJECT: [/^(?:仅项目|保留项目|不提升|不要提升|只在当前项目)$/u],
  PROMOTE_GLOBAL: [/^(?:提升全局|设为全局|全局使用|提升为全局知识)$/u],
  KEEP_RULE: [/^(?:保留规则|不覆盖|拒绝覆盖|保持现有规则)$/u],
  APPLY_OVERRIDE: [/^(?:允许覆盖|应用覆盖|覆盖规则|同意覆盖)$/u],
  STOP_WITHOUT_EXPANSION: [/^(?:停止|不用继续|停止任务|不继续)$/u],
  CONTINUE_ORIGINAL_SCOPE: [/^(?:继续|继续原任务|按原范围继续|只按原任务继续)$/u],
  KEEP_CURRENT: [/^(?:保持当前|保留当前)$/u],
};

const CORRECTION = /^(?:(?:不对|不是(?:这个|上述|该)?(?:方案|结论|实现|意思)?)(?:应该是?|应为|改成|改为)|纠正(?:为|是)|改成|改为|应该是|应为)/u;

export function matchConfirmationReply(request: ConfirmationRequest, statement: string): ConfirmationMatch {
  const normalized = normalize(statement);
  if (normalized.length === 0) return { status: "NO_MATCH" };
  const exact = new Set<ConfirmationOption>();
  request.options.forEach((option, index) => {
    if (normalized === normalize(option.optionId) || normalized === normalize(option.label)
      || normalized === String(index + 1)
      || (PHRASES[option.effect] ?? []).some((pattern) => pattern.test(normalized))) exact.add(option);
  });
  const correction = request.kind === "KNOWLEDGE_CONFLICT" && CORRECTION.test(normalized);
  if (correction && exact.size > 0) return { status: "AMBIGUOUS" };
  if (correction) {
    const rejected = request.options.find((option) => option.effect === "REJECT_CANDIDATE");
    return rejected === undefined ? { status: "NO_MATCH" } : { status: "MATCH", option: rejected, responseKind: "CORRECTION" };
  }
  if (exact.size === 0) return { status: "NO_MATCH" };
  if (exact.size > 1) return { status: "AMBIGUOUS" };
  const option = [...exact][0];
  return option === undefined ? { status: "NO_MATCH" } : { status: "MATCH", option, responseKind: "OPTION" };
}
