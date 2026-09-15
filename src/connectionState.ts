export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export type ConnectionHealth = {
  status: 'unknown' | 'checking' | 'online' | 'offline';
  latencyMs: number | null;
  lastCheckedAt: number | null;
  error: string;
  code?: string;
};

export const CONNECTION_HEALTH_INTERVAL_MS = 5000;
export const CONNECTION_HEALTH_TIMEOUT_MS = 3500;

export const defaultConnectionHealth: ConnectionHealth = Object.freeze({
  status: 'unknown',
  latencyMs: null,
  lastCheckedAt: null,
  error: '',
  code: '',
});
