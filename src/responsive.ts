export type ResponsiveMetrics = {
  width: number;
  height: number;
  /** True when screen width exceeds screen height. */
  isLandscape: boolean;
  /** True when screen height is greater than or equal to screen width. */
  isPortrait: boolean;
  /** True on iPad, Android tablets, or large devices (shortest dimension >= 600). */
  isTablet: boolean;
  /** True when width is >= 768px (iPad portrait, large tablet, or wide landscape). */
  isWide: boolean;
  /** True when width is >= 1024px (iPad landscape, desktop, or large screen). */
  isLarge: boolean;
  /** Convenience flag: true if in landscape OR width >= 768px. */
  isLandscapeOrWide: boolean;
};

/**
 * Pure calculation helper for breakpoint and orientation metrics.
 */
export function computeResponsiveMetrics(width: number, height: number): ResponsiveMetrics {
  const isLandscape = width > height;
  const isPortrait = !isLandscape;
  const shortest = Math.min(width, height);
  const isTablet = shortest >= 600;
  const isWide = width >= 768;
  const isLarge = width >= 1024;
  const isLandscapeOrWide = isLandscape || isWide;

  return {
    width,
    height,
    isLandscape,
    isPortrait,
    isTablet,
    isWide,
    isLarge,
    isLandscapeOrWide,
  };
}

/** Available chat column width, independent of the device's orientation. */
export function messageBubbleMaxWidth(containerWidth: number, outgoing: boolean): number {
  const available = Math.max(0, containerWidth - 24);
  return Math.floor(Math.min(outgoing ? 640 : 800, available * (outgoing ? 0.88 : 1)));
}
