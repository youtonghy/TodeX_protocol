/**
 * Agent Calling: one TodeX agent calls another.
 *
 * Two entry points share one backend call layer and one settings layer
 * (`GET|PUT /v2/agent-calling`, see `AgentCallingSettings` in `v2.ts`):
 *
 * - CLI entry: the external API (`/api/v1/*`) authenticated with API keys.
 * - MCP entry: the injected `todex_agents` MCP server; an agent running in
 *   TodeX starts a child conversation with another agent. The parent's
 *   journal records each call as `agent.call.*` events, projected into
 *   `ConversationRuntime.agentCalls`.
 */

/** MCP server name agents see; tools appear as `mcp__todex_agents__agent_run`. */
export const AGENT_CALLING_SERVER = 'todex_agents';

/** Tools of {@link AGENT_CALLING_SERVER}; each mirrors an `/api/v1` endpoint. */
export const AGENT_CALLING_TOOLS = ['agents_list', 'agent_run', 'agent_turn', 'agent_wait', 'agent_cancel'] as const;
export type AgentCallingTool = typeof AGENT_CALLING_TOOLS[number];

/** The `/api/v1` endpoint each tool mirrors (`agent_wait` has none). */
export const AGENT_CALLING_TOOL_ENDPOINTS: Record<AgentCallingTool, string | null> = {
  agents_list: 'GET /agents',
  agent_run: 'POST /runs',
  agent_turn: 'POST /conversations/{id}/turns',
  agent_wait: null,
  agent_cancel: 'POST /conversations/{id}/cancel',
};

export function isAgentCallingTool(value: unknown): value is AgentCallingTool {
  return typeof value === 'string' && (AGENT_CALLING_TOOLS as readonly string[]).includes(value);
}

/** Status of one call (a child turn) and of a child conversation (its latest turn). */
export type AgentCallStatus = 'running' | 'waiting_permission' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export const AGENT_CALL_STATUSES: readonly AgentCallStatus[] = ['running', 'waiting_permission', 'completed', 'failed', 'cancelled', 'interrupted'];

export function isActiveAgentCallStatus(status: AgentCallStatus): boolean {
  return status === 'running' || status === 'waiting_permission';
}

export type AgentCallError = { code?: string; message: string };

/** One turn of a child conversation, started by `agent_run` or `agent_turn`. */
export type AgentCallTurn = {
  childTurnId: string;
  /** The task the parent agent sent. */
  text: string;
  model?: string;
  reasoningEffort?: string;
  status: AgentCallStatus;
  output?: string;
  error?: AgentCallError;
  /** ISO 8601. */
  startedAt?: string;
  durationMs?: number;
};

/** A child conversation as the parent's journal describes it. */
export type AgentCallSession = {
  childConversationId: string;
  /** Provider id (`codex`, `claude-code`, ...); '' until the start event is loaded. */
  agent: string;
  title?: string;
  /** The latest turn's status. */
  status: AgentCallStatus;
  /** Start order. */
  turns: AgentCallTurn[];
  /** Sequence of the newest parent event about this child. */
  updatedSequence: number;
};

// ---- Parent conversation events ---------------------------------------------
// Payload keys name the child explicitly; `turnId`/`conversationId` belong to
// the parent (the supervisor stamps the parent's turn id into payloads).

/** `agent.call.started` */
export type AgentCallStartedEvent = {
  childConversationId: string;
  childTurnId: string;
  agent: string;
  model?: string;
  reasoningEffort?: string;
  text: string;
  title?: string;
  status: 'running';
  startedAt: string;
};

/** `agent.call.updated` */
export type AgentCallUpdatedEvent = {
  childConversationId: string;
  childTurnId: string;
  status: 'running' | 'waiting_permission';
};

/** `agent.call.completed` */
export type AgentCallCompletedEvent = {
  childConversationId: string;
  childTurnId: string;
  status: 'completed';
  output: string;
  durationMs: number;
};

/** `agent.call.failed`; `error.code` is `DAEMON_RESTARTED` for calls a daemon restart cut off. */
export type AgentCallFailedEvent = {
  childConversationId: string;
  childTurnId: string;
  status: 'failed' | 'interrupted';
  error: AgentCallError;
  output?: string;
  durationMs?: number;
};

/** `agent.call.cancelled` */
export type AgentCallCancelledEvent = {
  childConversationId: string;
  childTurnId: string;
  status: 'cancelled';
  output?: string;
  durationMs?: number;
};

export type AgentCallEventType = 'agent.call.started' | 'agent.call.updated' | 'agent.call.completed' | 'agent.call.failed' | 'agent.call.cancelled';

/**
 * The Agent Calling tool a provider-native tool name names, or null:
 * `mcp__todex_agents__agent_run` (Claude), `todex_agents.agent_run` (Codex),
 * `todex_agents/agent_run` or `todex_agents__agent_run`.
 */
export function agentCallingToolFromName(name: string): AgentCallingTool | null {
  const match = /^(?:mcp__)?todex_agents(?:__|\.|\/|:)([a-z_]+)$/.exec(name.trim());
  return match && isAgentCallingTool(match[1]) ? match[1] : null;
}

/** One-line summary of an Agent Calling tool call's arguments (JSON text):
 * `codex · <first line of the task>` for runs, the conversation id otherwise. */
export function agentCallingToolSummary(argsText: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsText) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    return '';
  }
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
  const task = text('text').split('\n').map(line => line.trim()).find(Boolean) ?? '';
  const shortTask = task.length > 120 ? `${task.slice(0, 120)}…` : task;
  return [text('agent') || text('conversationId'), shortTask].filter(Boolean).join(' · ');
}
