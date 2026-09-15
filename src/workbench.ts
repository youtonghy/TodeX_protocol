export const WORKBENCH_TABS = ['terminal', 'browser', 'files', 'git-diff'] as const;

export type WorkbenchTab = (typeof WORKBENCH_TABS)[number];
