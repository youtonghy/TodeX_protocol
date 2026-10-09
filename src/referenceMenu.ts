import type { HostApp } from './agentDesktop';
import type { CapabilitySuggestion } from './capabilityCatalog';
import { sshHostEndpoint, type SshHost } from './ssh';

/**
 * The composer `@` menu is two-level: `@` lists reference types, `@type:query`
 * searches one type. The type prefix is only menu navigation; picking an item
 * inserts the same text or chip as before (`@path`, a skill chip, `#mcp`, a
 * conversation export), so prompts sent to agents keep their format.
 */
export const REFERENCE_TYPES = ['file', 'folder', 'chat', 'skill', 'mcp', 'ssh', 'app'] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

export const REFERENCE_SUGGESTION_LIMIT = 8;
/** Entries requested when only one kind is shown; the backend has no kind filter. */
export const TYPED_ENTRY_FETCH_LIMIT = 100;

export type ReferenceMenuState =
  /** No type chosen yet: type rows plus the plain `@path` file search. */
  | { stage: 'type'; prefix: string }
  | { stage: 'item'; type: ReferenceType; query: string };

export type WorkspaceEntryLike = { name: string; path: string; kind: 'directory' | 'file' };

export type ReferenceConversationLike = {
  id: string;
  workspaceId: string;
  title: string;
  archived?: boolean;
  preview?: string;
};

export type ReferenceSuggestion = {
  id: string;
  /** Shown as typed in the popup, e.g. `@file:`, `@src/app.ts`, `#github`. */
  label: string;
  description: string;
  action:
    /** Replace the trigger with this text (type rows, files, folders). */
    | { kind: 'insert'; text: string }
    | { kind: 'conversation'; conversationId: string; title: string }
    | { kind: 'capability'; item: CapabilitySuggestion };
};

const isReferenceType = (value: string): value is ReferenceType =>
  (REFERENCE_TYPES as readonly string[]).includes(value);

/** Unknown prefixes (`@foo:bar`, `@C:/x`) stay a plain file search: file names may contain colons. */
export function referenceMenuState(query: string): ReferenceMenuState {
  const colon = query.indexOf(':');
  const type = colon > 0 ? query.slice(0, colon).toLowerCase() : '';
  if (isReferenceType(type)) return { stage: 'item', type, query: query.slice(colon + 1) };
  return { stage: 'type', prefix: query };
}

export function buildReferenceTypeSuggestions(
  prefix: string,
  describe: (type: ReferenceType) => string,
): ReferenceSuggestion[] {
  const lowered = prefix.toLowerCase();
  return REFERENCE_TYPES.filter((type) => type.startsWith(lowered)).map((type) => ({
    id: `type:${type}`,
    label: `@${type}:`,
    description: describe(type),
    action: { kind: 'insert', text: `@${type}:` },
  }));
}

/**
 * `mode` undefined is the untyped `@query` search (unchanged behavior).
 * `file` lists files and offers folders as rows that browse into them;
 * `folder` lists folders as the final reference.
 */
export function buildEntryReferenceSuggestions(
  entries: readonly WorkspaceEntryLike[],
  mode?: 'file' | 'folder',
): ReferenceSuggestion[] {
  const shown = mode === 'folder' ? entries.filter((entry) => entry.kind === 'directory') : entries;
  return shown.slice(0, REFERENCE_SUGGESTION_LIMIT).map((entry) => {
    const directory = entry.kind === 'directory';
    const text = !directory ? `@${entry.path} `
      : mode === 'folder' ? `@${entry.path.replace(/\/+$/, '')}/ `
        : mode === 'file' ? `@file:${entry.path.replace(/\/+$/, '')}/`
          : `@${entry.path}`;
    return {
      id: `${entry.kind}:${entry.path}`,
      label: `@${directory ? `${entry.path.replace(/\/+$/, '')}/` : entry.path}`,
      description: entry.name,
      action: { kind: 'insert', text },
    };
  });
}

/** The trigger ends at whitespace, so titles match with their spaces removed. */
export function buildChatReferenceSuggestions(
  query: string,
  conversations: readonly ReferenceConversationLike[],
  workspaceId: string,
  currentConversationId: string,
  untitled: string,
): ReferenceSuggestion[] {
  const needle = query.toLowerCase();
  return conversations
    .filter((item) => item.workspaceId === workspaceId && item.id !== currentConversationId && !item.archived)
    .filter((item) => !needle || (item.title || untitled).toLowerCase().replace(/\s+/g, '').includes(needle))
    .slice(0, REFERENCE_SUGGESTION_LIMIT)
    .map((item) => {
      const title = item.title || untitled;
      return {
        id: `chat:${item.id}`,
        label: title,
        description: (item.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        action: { kind: 'conversation', conversationId: item.id, title },
      };
    });
}

/** `@ssh:` lists the backend SSH hosts the user allowed agents to call
 * (`agentAccess`); hosts without it are never offered. Picking one inserts an
 * `@ssh:<alias>` mention, and the agent drives the host through its `ssh_exec`
 * tool — the resulting `ssh.exec.*` activity shows in read-only tabs. Matches
 * on the alias or the resolved `user@host:port` endpoint. */
export function buildSshReferenceSuggestions(query: string, hosts: readonly SshHost[]): ReferenceSuggestion[] {
  const needle = query.toLowerCase();
  return hosts
    .filter((host) => host.agentAccess)
    .filter((host) => !needle || host.alias.toLowerCase().includes(needle) || sshHostEndpoint(host).toLowerCase().includes(needle))
    .slice(0, REFERENCE_SUGGESTION_LIMIT)
    .map((host) => ({
      id: `ssh:${host.alias}`,
      label: host.alias,
      description: sshHostEndpoint(host),
      action: { kind: 'insert' as const, text: `@ssh:${host.alias} ` },
    }));
}

/** `@app:` lists apps on the backend host (`GET /v2/agent-desktop/computer/apps`),
 * matched on name or id. Picking one inserts `@app:<id>`; the agent passes the
 * id to Computer Use (`open_app`), whose per-app approval still applies. */
export function buildAppReferenceSuggestions(
  query: string,
  apps: readonly HostApp[],
  describe: (app: HostApp) => string = (app) => app.id,
): ReferenceSuggestion[] {
  const needle = query.toLowerCase();
  return apps
    .filter((app) => !needle || app.name.toLowerCase().replace(/\s+/g, '').includes(needle) || app.id.toLowerCase().includes(needle))
    .slice(0, REFERENCE_SUGGESTION_LIMIT)
    .map((app) => ({
      id: `app:${app.id}`,
      label: app.name || app.id,
      description: describe(app),
      action: { kind: 'insert' as const, text: `@app:${app.id} ` },
    }));
}

/** `items` should come from `buildCapabilitySuggestions` with a limit large
 * enough that filtering one kind still fills the list. */
export function buildCapabilityReferenceSuggestions(
  items: readonly CapabilitySuggestion[],
  kind: 'skill' | 'mcp',
): ReferenceSuggestion[] {
  return items
    .filter((item) => item.kind === kind)
    .slice(0, REFERENCE_SUGGESTION_LIMIT)
    .map((item) => ({ id: item.id, label: item.name, description: item.description, action: { kind: 'capability', item } }));
}
