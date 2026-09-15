export type SplitDimensions = {
  totalWidth: number;
  minLeftWidth?: number;
  minRightWidth?: number;
  defaultRatio?: number;
};

export const SPLIT_DIVIDER_WIDTH = 20;
export const MIN_SPLIT_WIDTH = 360 + 360 + SPLIT_DIVIDER_WIDTH;

export function canSplitWidth(width: number, minLeft = 360, minRight = 360): boolean {
  return Number.isFinite(width) && width >= minLeft + minRight + SPLIT_DIVIDER_WIDTH;
}

export const DEFAULT_SPLIT_RATIO = 0.52;
export const DEFAULT_MIN_LEFT_WIDTH = 360;
export const DEFAULT_MIN_RIGHT_WIDTH = 360;

/**
 * 计算受边界约束的双栏左侧宽度。
 * 当总宽度无法同时满足左右最小宽度时，优先保证均分或左侧最小宽度。
 */
export function clampSplitLeftWidth(
  targetWidth: number,
  totalWidth: number,
  minLeftWidth: number = DEFAULT_MIN_LEFT_WIDTH,
  minRightWidth: number = DEFAULT_MIN_RIGHT_WIDTH,
): number {
  if (totalWidth <= 0) return Math.round(targetWidth);
  const effectiveMinLeft = Math.min(minLeftWidth, totalWidth / 2);
  const maxLeft = Math.max(effectiveMinLeft, totalWidth - minRightWidth);
  return Math.max(effectiveMinLeft, Math.min(maxLeft, Math.round(targetWidth)));
}

/**
 * 根据总宽度与期望比例计算左侧宽度
 */
export function calculateSplitLeftWidth(
  totalWidth: number,
  ratio: number = DEFAULT_SPLIT_RATIO,
  minLeftWidth: number = DEFAULT_MIN_LEFT_WIDTH,
  minRightWidth: number = DEFAULT_MIN_RIGHT_WIDTH,
): number {
  if (totalWidth <= 0) return 0;
  const rawTarget = Math.round(totalWidth * ratio);
  return clampSplitLeftWidth(rawTarget, totalWidth, minLeftWidth, minRightWidth);
}

/** Final layout always accounts for the divider, including the first resize render. */
export function resolveSplitLayout(
  containerWidth: number,
  requestedLeftWidth: number,
  enabled: boolean,
  minLeftWidth = DEFAULT_MIN_LEFT_WIDTH,
  minRightWidth = DEFAULT_MIN_RIGHT_WIDTH,
): { split: boolean; leftWidth: number; rightWidth: number; dividerWidth: number } {
  const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  if (!enabled || !canSplitWidth(width, minLeftWidth, minRightWidth)) {
    return { split: false, leftWidth: width, rightWidth: 0, dividerWidth: 0 };
  }
  const available = width - SPLIT_DIVIDER_WIDTH;
  const requested = Number.isFinite(requestedLeftWidth) && requestedLeftWidth > 0
    ? requestedLeftWidth : available * DEFAULT_SPLIT_RATIO;
  const leftWidth = clampSplitLeftWidth(requested, available, minLeftWidth, minRightWidth);
  return { split: true, leftWidth, rightWidth: available - leftWidth, dividerWidth: SPLIT_DIVIDER_WIDTH };
}
