/**
 * Provider-agnostic reading of a tool timeline entry. Tool subtitles are JSON
 * snapshots whose shape depends on the provider — Pi/ACP `{toolName,
 * arguments, result}`, Codex app-server `item` records, Claude `tool_use`
 * blocks — so clients read them through this one parser instead of guessing
 * field names per screen.
 */

type JsonRecord = Record<string, unknown>;

export type ToolCallKind = 'command' | 'fileChange' | 'webSearch' | 'tool';
export type ToolCallStatus = 'running' | 'completed' | 'failed' | 'unknown';
/** What a call does, recognized across providers so clients can phrase it
 * ("Reading page.tsx", "Ran 2 commands") instead of echoing tool names. */
export type ToolAction = 'read' | 'search' | 'edit' | 'command' | 'web' | 'agent' | 'other';

export interface ToolCallPresentation {
  /** Coarse kind, used for a localized label when the provider sent no name. */
  kind: ToolCallKind;
  /** Provider-native tool name; empty when the event carries none. */
  name: string;
  /** One-line key argument (command, path, query); empty when none. */
  summary: string;
  /** Full arguments for the expanded view; empty when there are none. */
  argsText: string;
  /** Latest output (final or partial); undefined until the tool returns. */
  outputText?: string;
  errorText?: string;
  status: ToolCallStatus;
  action: ToolAction;
  /** Files a `read` or `edit` call works on, in call order; empty otherwise. */
  targets: string[];
}

const SUMMARY_MAX_CHARS = 160;
/** Expanded bodies are previews: full file reads or diffs would stall the
 * highlighter, and the raw event stays available through the event log. */
const DETAIL_MAX_CHARS = 8000;
/** Argument keys that best identify a call, in priority order. Antigravity
 * (agy) names its arguments in PascalCase (`run_command` sends
 * `CommandLine`, file tools `Path`/`TargetFile`/`AbsolutePath`). */
const SUMMARY_KEYS = [
  'command', 'cmd', 'CommandLine',
  'file_path', 'filePath', 'TargetFile', 'AbsolutePath',
  'path', 'Path', 'notebook_path', 'DirectoryPath', 'SearchPath', 'SearchDirectory',
  'pattern', 'Pattern', 'query', 'Query', 'url', 'Url',
  'description', 'prompt',
];
const COMMAND_KEYS = new Set(['command', 'cmd', 'CommandLine']);
/** Argument keys holding the file a read or edit works on. */
const FILE_KEYS = ['file_path', 'filePath', 'TargetFile', 'AbsolutePath', 'notebook_path', 'path', 'Path'];
/** Built-in tool names per action, compared lowercased without `_`/`-`:
 * Claude (`Read`, `MultiEdit`), Pi (`read`, `bash`), Antigravity
 * (`view_file`, `run_command`, `write_to_file`), Codex item types. */
const ACTION_NAMES: Record<Exclude<ToolAction, 'other'>, readonly string[]> = {
  read: ['read', 'readfile', 'view', 'viewfile', 'viewfileoutline', 'viewcodeitem', 'notebookread', 'imageview'],
  search: ['grep', 'glob', 'ls', 'find', 'list', 'listdir', 'grepsearch', 'findbyname', 'codebasesearch', 'search'],
  edit: ['edit', 'write', 'multiedit', 'notebookedit', 'writefile', 'writetofile', 'replacefilecontent', 'multireplacefilecontent', 'applypatch', 'patch'],
  command: ['bash', 'shell', 'localshell', 'runcommand', 'execcommand', 'commandstatus', 'sendcommandinput', 'readterminal'],
  web: ['websearch', 'webfetch', 'searchweb', 'readurlcontent', 'fetch'],
  agent: ['task', 'agent', 'subagent', 'spawnagent'],
};
const ACTION_BY_NAME = new Map<string, ToolAction>(
  Object.entries(ACTION_NAMES).flatMap(([action, names]) => names.map((name) => [name, action as ToolAction])),
);
/** ACP `ToolKind` values, the fallback when a tool name is unknown. */
const ACP_KIND_ACTIONS: Record<string, ToolAction> = {
  read: 'read', edit: 'edit', delete: 'edit', move: 'edit', search: 'search', execute: 'command', fetch: 'web',
};
const KIND_ACTIONS: Record<ToolCallKind, ToolAction> = {
  command: 'command', fileChange: 'edit', webSearch: 'web', tool: 'other',
};

const CODEX_ITEM_KINDS: Record<string, ToolCallKind> = {
  commandExecution: 'command',
  command_execution: 'command',
  fileChange: 'fileChange',
  file_change: 'fileChange',
  webSearch: 'webSearch',
  web_search: 'webSearch',
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function nonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function oneLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  return line.length > SUMMARY_MAX_CHARS ? `${line.slice(0, SUMMARY_MAX_CHARS)}…` : line;
}

function commandText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) && value.every((part) => typeof part === 'string') ? value.join(' ') : '';
}

/** Arguments sometimes arrive as a JSON string; parse them for summarizing. */
function parsedArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

function argsSummary(args: unknown): string {
  const parsed = parsedArgs(args);
  if (typeof parsed === 'string') return oneLine(parsed);
  const record = asRecord(parsed);
  if (!record) return '';
  // Clarifying-question tools (Claude `AskUserQuestion`) carry no command or
  // path; the questions themselves identify the call.
  if (Array.isArray(record.questions)) {
    const questions = record.questions.map((question) => nonEmptyString(asRecord(question)?.question)).filter(Boolean);
    if (questions.length) return oneLine(questions.join(' / '));
  }
  // A plan handed in for approval (Claude `ExitPlanMode`): its first line,
  // without Markdown heading marks.
  if (typeof record.plan === 'string' && record.plan.trim()) return oneLine(record.plan.replace(/^\s*#+\s*/gm, ''));
  for (const key of SUMMARY_KEYS) {
    const text = COMMAND_KEYS.has(key) ? commandText(record[key]) : nonEmptyString(record[key]);
    if (text.trim()) return oneLine(text);
  }
  return '';
}

function boundedDetail(text: string): string {
  return text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS)}…` : text;
}

function detailText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return boundedDetail(value);
  if (typeof value === 'object' && Object.keys(value).length === 0) return '';
  try {
    return boundedDetail(JSON.stringify(value, null, 2) ?? '');
  } catch {
    return boundedDetail(String(value));
  }
}

/** MCP-style results wrap text in `{content: [{type: 'text', text}]}`. */
function readableOutput(value: unknown): unknown {
  const content = asRecord(value)?.content;
  if (!Array.isArray(content)) return value;
  const text = content
    .map((part) => asRecord(part))
    .filter((part): part is JsonRecord => Boolean(part) && typeof part?.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
  return text || value;
}

function errorMessage(value: unknown): string {
  return nonEmptyString(value, asRecord(value)?.message);
}

function statusFrom(value: JsonRecord, output: unknown, errorText: string): ToolCallStatus {
  if (value.isError === true || value.is_error === true || errorText) return 'failed';
  const exitCode = value.exitCode ?? value.exit_code;
  if (typeof exitCode === 'number' && exitCode !== 0) return 'failed';
  const status = nonEmptyString(value.status).toLowerCase().replace(/[\s_-]/g, '');
  if (['failed', 'error', 'declined', 'rejected', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (['completed', 'complete', 'success', 'succeeded', 'done'].includes(status)) return 'completed';
  if (['inprogress', 'pending', 'running', 'started'].includes(status)) return 'running';
  if (value.result !== undefined && value.result !== null) return 'completed';
  if (typeof exitCode === 'number') return 'completed';
  return output === undefined ? 'unknown' : 'running';
}

function actionFor(kind: ToolCallKind, name: string, acpKind: string): ToolAction {
  if (kind !== 'tool') return KIND_ACTIONS[kind];
  // TodeX Agent Calling tools (`mcp__todex_agents__agent_run`) start agents.
  if (/todex_agents/i.test(name)) return 'agent';
  return ACTION_BY_NAME.get(name.toLowerCase().replace(/[_-]/g, ''))
    ?? ACP_KIND_ACTIONS[acpKind.toLowerCase()]
    ?? 'other';
}

/** Distinct, non-empty file paths in first-seen order. */
function distinctPaths(paths: unknown[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    const text = nonEmptyString(path);
    if (text) seen.add(text);
  }
  return [...seen];
}

/** The files a call names: its file argument, else ACP `locations`. */
function fileTargets(args: unknown, locations: unknown): string[] {
  const record = asRecord(parsedArgs(args));
  const fromArgs = record ? FILE_KEYS.map((key) => record[key]).find((value) => nonEmptyString(value)) : undefined;
  if (fromArgs) return distinctPaths([fromArgs]);
  return Array.isArray(locations) ? distinctPaths(locations.map((location) => asRecord(location)?.path)) : [];
}

function codexItemPresentation(item: JsonRecord, type: string): ToolCallPresentation {
  const kind = CODEX_ITEM_KINDS[type] ?? 'tool';
  const errorText = errorMessage(item.error);
  let summary = '';
  let args: unknown = item.arguments;
  let output: unknown = item.result ?? item.aggregatedOutput ?? item.aggregated_output ?? item.output;
  if (kind === 'command') {
    summary = oneLine(commandText(item.command));
    args = { command: item.command, ...(item.cwd ? { cwd: item.cwd } : {}) };
  } else if (kind === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes.map(asRecord).filter(Boolean) as JsonRecord[] : [];
    summary = oneLine(changes.map((change) => nonEmptyString(change.path)).filter(Boolean).join(', '));
    args = changes.length ? changes : undefined;
    output = undefined;
  } else if (kind === 'webSearch') {
    summary = oneLine(nonEmptyString(item.query));
  } else {
    summary = argsSummary(item.arguments) || oneLine(nonEmptyString(item.path, item.prompt));
  }
  const tool = nonEmptyString(item.tool);
  const server = nonEmptyString(item.server);
  const name = tool ? (server ? `${server}.${tool}` : tool) : kind === 'tool' ? type : '';
  output = output === null || output === '' ? undefined : readableOutput(output);
  const action = actionFor(kind, tool || name, '');
  const targets = kind === 'fileChange' && Array.isArray(args) ? distinctPaths(args.map((change) => asRecord(change)?.path))
    // Other items (`imageView`, MCP file tools) name one file at most.
    : action === 'read' || action === 'edit' ? distinctPaths([item.path, ...fileTargets(item.arguments, undefined)]).slice(0, 1)
      : [];
  return {
    kind, name, summary, argsText: detailText(args), outputText: detailText(output) || undefined,
    errorText: errorText || undefined, status: statusFrom(item, output, errorText), action, targets,
  };
}

/** Describe a tool entry from its projected subtitle (JSON or plain text). */
export function describeToolCall(subtitle: string): ToolCallPresentation {
  let value: JsonRecord | null = null;
  try {
    value = asRecord(JSON.parse(subtitle));
  } catch {
    // Streaming deltas and legacy events carry plain text.
  }
  if (!value) {
    return { kind: 'tool', name: '', summary: oneLine(subtitle), argsText: boundedDetail(subtitle), status: 'unknown', action: 'other', targets: [] };
  }
  // Codex tool blocks project the bare app-server item, typed by `type`.
  // Claude streams `{tool: {type: 'tool_use', name, input}}`; ACP keeps the
  // raw update under `tool`, so the lifted fields win over it.
  const tool = asRecord(value.tool);
  const type = nonEmptyString(value.type);
  if (type && !tool && !nonEmptyString(value.toolName, value.tool_name)) {
    return codexItemPresentation(value, type);
  }
  const toolCall = asRecord(value.toolCall) ?? asRecord(value.tool_call);
  const name = nonEmptyString(value.toolName, value.tool_name, value.name, value.tool, tool?.name, toolCall?.name, toolCall?.toolName);
  const args = value.arguments ?? value.input ?? value.args ?? tool?.input ?? toolCall?.arguments ?? toolCall?.input
    ?? (typeof value.command === 'string' ? { command: value.command } : undefined);
  const title = nonEmptyString(value.title);
  const summary = argsSummary(args) || (title && title !== name ? oneLine(title) : '');
  const rawOutput = value.result ?? value.partialResult ?? value.partial_result ?? value.output;
  const output = rawOutput === null || rawOutput === '' ? undefined : readableOutput(rawOutput);
  const errorText = errorMessage(value.error);
  const kind: ToolCallKind = !name && typeof value.command === 'string' ? 'command' : 'tool';
  const action = actionFor(kind, name, nonEmptyString(value.kind, tool?.kind, toolCall?.kind));
  return {
    kind,
    name,
    summary,
    argsText: detailText(args),
    outputText: detailText(output) || undefined,
    errorText: errorText || undefined,
    status: statusFrom(value, output, errorText),
    action,
    targets: action === 'read' || action === 'edit' ? fileTargets(args, value.locations ?? tool?.locations) : [],
  };
}

export interface ToolActionCount {
  action: ToolAction;
  /** Distinct files for `read`/`edit` (a call naming none counts once);
   * calls for every other action. */
  count: number;
}

/** Order in which a finished run's work is summarized. */
const SUMMARY_ORDER: readonly ToolAction[] = ['edit', 'command', 'read', 'search', 'web', 'agent', 'other'];

/** Tally a run's calls by action ("edited 2 files, ran 3 commands"); actions
 * that never occurred are left out. */
export function summarizeToolActions(calls: readonly Pick<ToolCallPresentation, 'action' | 'targets'>[]): ToolActionCount[] {
  const files = new Map<ToolAction, Set<string>>();
  const counts = new Map<ToolAction, number>();
  for (const call of calls) {
    if ((call.action === 'read' || call.action === 'edit') && call.targets.length) {
      const seen = files.get(call.action) ?? new Set<string>();
      for (const target of call.targets) seen.add(target);
      files.set(call.action, seen);
    } else {
      counts.set(call.action, (counts.get(call.action) ?? 0) + 1);
    }
  }
  return SUMMARY_ORDER
    .map((action) => ({ action, count: (counts.get(action) ?? 0) + (files.get(action)?.size ?? 0) }))
    .filter((entry) => entry.count > 0);
}
