import type { McpCatalog, McpServerCatalogDescriptor, ProviderKind, SkillCatalog, SkillCatalogDescriptor } from './v2';

export type CatalogState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  skills?: SkillCatalog;
  mcp?: McpCatalog;
  error?: string;
};

export type CapabilityCatalogMap = Partial<Record<ProviderKind, CatalogState>>;

/** One row in the composer's `#` popup: a catalog skill to attach, or an MCP
 * server to reference as inline `#name` text. */
export type CapabilitySuggestion =
  | {
    kind: 'skill';
    id: string;
    name: string;
    description: string;
    provider: ProviderKind;
    skill: SkillCatalogDescriptor;
    attached: boolean;
  }
  | {
    kind: 'mcp';
    id: string;
    name: string;
    description: string;
    provider: ProviderKind;
    server: McpServerCatalogDescriptor;
  };

export const CAPABILITY_SUGGESTION_LIMIT = 8;

/** True while any provider's catalog is still missing or loading, so the popup
 * can show a loading row instead of a premature "no matches". */
export function capabilityCatalogsPending(
  catalogs: CapabilityCatalogMap,
  providers: readonly ProviderKind[],
): boolean {
  return providers.some((provider) => {
    const state = catalogs[provider];
    return !state || state.status === 'idle' || state.status === 'loading';
  });
}

/** Flattens every provider catalog into one filtered, deduplicated suggestion
 * list for the `#` trigger. `providers` sets display order, so callers pass the
 * active conversation's provider first. */
export function buildCapabilitySuggestions(
  catalogs: CapabilityCatalogMap,
  providers: readonly ProviderKind[],
  query: string,
  options: {
    limit?: number;
    isSkillAttached?: (skill: SkillCatalogDescriptor) => boolean;
  } = {},
): CapabilitySuggestion[] {
  const lowered = query.trim().toLowerCase();
  const matches = (name: string, extra: string) =>
    !lowered || name.toLowerCase().includes(lowered) || extra.toLowerCase().includes(lowered);
  const skills: CapabilitySuggestion[] = [];
  const mcps: CapabilitySuggestion[] = [];
  const seenSkills = new Set<string>();
  const seenMcps = new Set<string>();
  for (const provider of providers) {
    const catalog = catalogs[provider];
    if (!catalog) continue;
    for (const skill of catalog.skills?.skills ?? []) {
      if (!skill.valid || !skill.resourceId) continue;
      const key = `${skill.resourceId}:${skill.name}`;
      if (seenSkills.has(key) || !matches(skill.name, skill.description || skill.source)) continue;
      seenSkills.add(key);
      skills.push({
        kind: 'skill',
        id: `skill:${key}`,
        name: skill.name,
        description: skill.description || skill.source,
        provider: catalog.skills?.provider ?? provider,
        skill,
        attached: options.isSkillAttached?.(skill) ?? false,
      });
    }
    for (const server of catalog.mcp?.servers ?? []) {
      if (!server.enabled) continue;
      const key = server.resourceId || `${server.name}:${server.source}`;
      if (seenMcps.has(key) || !matches(server.name, server.source)) continue;
      seenMcps.add(key);
      mcps.push({
        kind: 'mcp',
        id: `mcp:${key}`,
        name: server.name,
        description: `${server.transport} · ${server.source}`,
        provider: server.provider ?? provider,
        server,
      });
    }
  }
  return [...skills, ...mcps].slice(0, options.limit ?? CAPABILITY_SUGGESTION_LIMIT);
}
