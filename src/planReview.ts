import { isObject } from './primitives';

/** Claude Code's tool for leaving Plan mode with a plan to approve. */
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';

/**
 * The plan a permission request asks the person to approve, from its `kind`
 * and `details`; undefined when the request is not a plan review.
 *
 * Plan reviews arrive as `kind: "plan"` with the plan text at `details.plan`
 * (Claude Code, Grok Build). Older backends sent Claude's `ExitPlanMode` as a
 * plain tool approval, whose plan sits at `details.input.plan`.
 */
export function planReviewText(kind: unknown, details: unknown): string | undefined {
  if (!isObject(details)) return undefined;
  const input = isObject(details.input) ? details.input : {};
  const isPlan = kind === 'plan' || details.tool_name === EXIT_PLAN_MODE_TOOL;
  if (!isPlan) return undefined;
  const plan = [details.plan, input.plan].find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  return plan;
}
