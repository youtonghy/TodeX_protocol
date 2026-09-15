import { buildHttpUrl, type ConnectionSettings } from './todex';

export interface GitWorkspaceBranch {
  name: string;
  current: boolean;
  remote: boolean;
  worktreePath?: string;
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  current: boolean;
  main: boolean;
  locked: boolean;
  dirty: boolean;
  accessible: boolean;
}

export interface GitWorkspaceSnapshot {
  repositoryPath: string;
  initialized: boolean;
  currentBranch: string | null;
  branches: GitWorkspaceBranch[];
  worktrees: GitWorktree[];
  dirty: boolean;
}

export type GitWorkspaceOperation =
  | { action: 'init' | 'push' }
  | { action: 'create-branch'; branchName: string; startPoint?: string }
  | { action: 'switch-branch'; branchName: string }
  | { action: 'create-worktree'; path: string; branchName: string; startPoint?: string }
  | { action: 'remove-worktree'; path: string };

export interface GitWorkspaceOperationResult {
  repositoryPath: string;
  action: GitWorkspaceOperation['action'];
  output: string;
}

export class GitWorkspaceError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly unknownOutcome: boolean;

  constructor(message: string, details: { status?: number; code?: string; unknownOutcome?: boolean } = {}) {
    super(message);
    this.name = 'GitWorkspaceError';
    this.status = details.status;
    this.code = details.code;
    this.unknownOutcome = details.unknownOutcome ?? false;
  }
}

const uncertainCodes = new Set(['GIT_PARTIAL_SUCCESS', 'GIT_COMMAND_TIMED_OUT', 'GIT_COMMAND_TIMEOUT', 'GIT_OUTCOME_UNKNOWN']);

async function request<T>(settings: ConnectionSettings, url: string, operation?: GitWorkspaceOperation,
  workspacePath?: string, externalSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), operation ? 120_000 : 15_000);
  try {
    const response = await fetch(url, {
      method: operation ? 'POST' : 'GET',
      headers: {
        ...(settings.authToken ? { Authorization: `Bearer ${settings.authToken}` } : {}),
        ...(operation ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(operation ? { body: JSON.stringify({ workspacePath, operation }) } : {}),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const data = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const code = typeof data.code === 'string' ? data.code : undefined;
      throw new GitWorkspaceError(typeof data.message === 'string' ? data.message : `Git 请求失败 (${response.status})`, {
        status: response.status, code,
        unknownOutcome: Boolean(operation && (data.unknownOutcome === true || (code && uncertainCodes.has(code)) || response.status >= 500)),
      });
    }
    if (!body || typeof body !== 'object') {
      throw new GitWorkspaceError('后端返回了无效的 Git 操作结果', { status: response.status, unknownOutcome: Boolean(operation) });
    }
    return body as T;
  } catch (error) {
    if (error instanceof GitWorkspaceError) throw error;
    throw new GitWorkspaceError(controller.signal.aborted ? 'Git 请求已取消或超时，请核对实际状态' : error instanceof Error ? error.message : 'Git 请求连接失败', {
      code: controller.signal.aborted ? 'REQUEST_ABORTED' : 'NETWORK_ERROR', unknownOutcome: Boolean(operation),
    });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abort);
  }
}

export function readGitWorkspace(settings: ConnectionSettings, workspacePath: string, signal?: AbortSignal): Promise<GitWorkspaceSnapshot> {
  const url = new URL(buildHttpUrl(settings.serverUrl, '/v2/git/workspace'));
  url.searchParams.set('workspacePath', workspacePath);
  return request(settings, url.toString(), undefined, undefined, signal);
}

export function runGitWorkspaceOperation(settings: ConnectionSettings, workspacePath: string,
  operation: GitWorkspaceOperation): Promise<GitWorkspaceOperationResult> {
  return request(settings, buildHttpUrl(settings.serverUrl, '/v2/git/operation'), operation, workspacePath);
}
