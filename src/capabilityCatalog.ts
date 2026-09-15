import type { McpCatalog, ProviderKind, SkillCatalog } from './v2';

export type CatalogState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  skills?: SkillCatalog;
  mcp?: McpCatalog;
  error?: string;
};

export type CapabilityCatalogMap = Partial<Record<ProviderKind, CatalogState>>;
