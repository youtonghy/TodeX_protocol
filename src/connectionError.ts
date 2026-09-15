export enum ConnectionErrorType {
  NETWORK_OFFLINE = 'NETWORK_OFFLINE',
  SERVER_UNREACHABLE = 'SERVER_UNREACHABLE',
  TIMEOUT = 'TIMEOUT',
  CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  SERVER_ERROR = 'SERVER_ERROR',
  PROTOCOL_ERROR = 'PROTOCOL_ERROR',
  MESSAGE_TOO_LARGE = 'MESSAGE_TOO_LARGE',
  HEARTBEAT_TIMEOUT = 'HEARTBEAT_TIMEOUT',
  INVALID_SERVER_URL = 'INVALID_SERVER_URL',
  PROTOCOL_MISMATCH = 'PROTOCOL_MISMATCH',
  WEBSOCKET_FAILED = 'WEBSOCKET_FAILED',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
}

export type ConnectionFailureCode =
  | 'backend_unreachable'
  | 'invalid_server_url'
  | 'authentication_failed'
  | 'protocol_mismatch'
  | 'websocket_failed'
  | 'provider_unavailable'
  | 'request_failed';

export class ConnectionError extends Error {
  constructor(
    public type: ConnectionErrorType,
    public userMessage: string,
    public technicalDetails: string,
    public retryable: boolean = false,
    public code: ConnectionFailureCode = 'backend_unreachable',
  ) {
    super(userMessage);
    this.name = 'ConnectionError';
  }

  static networkOffline(details: string): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.NETWORK_OFFLINE,
      '后端未启动或地址不可达',
      details,
      true,
      'backend_unreachable',
    );
  }

  static timeout(details: string): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.TIMEOUT,
      '连接超时，请确认 Backend 已启动',
      details,
      true,
      'backend_unreachable',
    );
  }

  static connectionTimeout(): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.CONNECTION_TIMEOUT,
      'WebSocket 握手超时',
      'WebSocket connection timeout after 10s',
      true,
      'websocket_failed',
    );
  }

  static authenticationFailed(status: number): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.AUTHENTICATION_FAILED,
      'Token 缺失或无效',
      `HTTP ${status}`,
      false,
      'authentication_failed',
    );
  }

  static serverError(status: number): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.SERVER_ERROR,
      '服务器暂时不可用，请稍后重试',
      `HTTP ${status}`,
      true,
      'backend_unreachable',
    );
  }

  static protocolError(status: number): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.PROTOCOL_ERROR,
      '请求失败，请检查网络连接',
      `HTTP ${status}`,
      true,
      'backend_unreachable',
    );
  }

  static messageTooLarge(size: number, max: number): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.MESSAGE_TOO_LARGE,
      '消息过大，无法发送',
      `Message size ${size} exceeds limit ${max}`,
      false,
      'backend_unreachable',
    );
  }

  static heartbeatTimeout(): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.HEARTBEAT_TIMEOUT,
      '连接已断开，正在尝试重连',
      'Missed heartbeats',
      true,
      'websocket_failed',
    );
  }

  static invalidServerUrl(details: string): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.INVALID_SERVER_URL,
      'Backend 地址无效',
      details,
      false,
      'invalid_server_url',
    );
  }

  static protocolMismatch(details: string): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.PROTOCOL_MISMATCH,
      '协议已废弃，请使用 /v2（不要使用 /v1）',
      details,
      false,
      'protocol_mismatch',
    );
  }

  static websocketFailed(details: string): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.WEBSOCKET_FAILED,
      'WebSocket 握手失败',
      details,
      true,
      'websocket_failed',
    );
  }

  static providerUnavailable(details: string): ConnectionError {
    return new ConnectionError(
      ConnectionErrorType.PROVIDER_UNAVAILABLE,
      details || '当前没有可用的 Agent',
      details,
      false,
      'provider_unavailable',
    );
  }

  static apiRequestFailed(status: number, backendCode?: string, backendMessage?: string): ConnectionError {
    const details = [
      `HTTP ${status}`,
      backendCode?.trim(),
      backendMessage?.trim(),
    ].filter(Boolean).join(' · ');
    let userMessage = backendMessage?.trim() || `请求失败（HTTP ${status}）`;
    switch (backendCode) {
      case 'WORKSPACE_PATH_NOT_FOUND':
        userMessage = '工作区目录不存在，请重新选择 Backend 上的目录';
        break;
      case 'WORKSPACE_PATH_OUTSIDE_ROOT':
        userMessage = '工作区目录不在 Backend 允许的根目录内';
        break;
      case 'PROVIDER_UNAVAILABLE':
        return ConnectionError.providerUnavailable(backendMessage?.trim() || '该 Agent 当前不可用');
      case 'GIT_PARTIAL_SUCCESS':
        return new ConnectionError(
          ConnectionErrorType.PROTOCOL_ERROR,
          '本地提交已创建，但推送失败；已刷新仓库状态，请检查远端后单独推送',
          details,
          false,
          'request_failed',
        );
    }
    if (status >= 500) {
      return new ConnectionError(
        ConnectionErrorType.SERVER_ERROR,
        '服务器暂时不可用，请稍后重试',
        details,
        true,
        'request_failed',
      );
    }
    return new ConnectionError(
      ConnectionErrorType.PROTOCOL_ERROR,
      userMessage,
      details,
      status >= 500,
      'request_failed',
    );
  }

  static unreachable(details: string): ConnectionError {
    const lower = details.toLowerCase();
    if (lower.includes('err_connection_refused') || lower.includes('econnrefused')) {
      return new ConnectionError(
        ConnectionErrorType.SERVER_UNREACHABLE,
        'Backend 未启动或端口错误（连接被拒绝）',
        details,
        true,
        'backend_unreachable',
      );
    }
    if (lower.includes('failed to fetch') || lower.includes('network request failed')) {
      return new ConnectionError(
        ConnectionErrorType.SERVER_UNREACHABLE,
        'Backend 未启动或地址不可达',
        details,
        true,
        'backend_unreachable',
      );
    }
    return ConnectionError.networkOffline(details);
  }
}

export function connectionFailureLabel(code?: ConnectionFailureCode | ''): string {
  switch (code) {
    case 'backend_unreachable':
      return 'Backend 未启动或端口错误';
    case 'invalid_server_url':
      return 'Backend 地址无效';
    case 'authentication_failed':
      return 'Token 缺失或无效';
    case 'protocol_mismatch':
      return '协议已废弃（/v1）';
    case 'websocket_failed':
      return 'WebSocket 握手失败';
    case 'provider_unavailable':
      return 'Agent 不可用';
    case 'request_failed':
      return '请求失败';
    default:
      return '';
  }
}
