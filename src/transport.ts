import { isObject, utf8ByteLength, type ServerEvent } from './todex';

/**
 * Must stay in sync with MAX_WS_MESSAGE_BYTES on the backend's unified
 * `/v2/ws` socket (server/v2.rs). The backend measures the frame it
 * receives, so this is checked after encryption rather than on the plaintext.
 */
export const MAX_LEGACY_MESSAGE_BYTES = 8 * 1024 * 1024;

export { utf8ByteLength };

export function cursorFromEvent(event: ServerEvent): number | null {
  if (typeof event.cursor === 'number' && Number.isFinite(event.cursor)) {
    return event.cursor;
  }
  if (typeof event.cursor === 'string') {
    const parsed = Number(event.cursor);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function sessionIdFromEvent(event: ServerEvent): string {
  const payload = isObject(event.payload) ? event.payload : {};
  const data = isObject(payload.data) ? payload.data : {};
  const candidates = [
    event.codex_session_id,
    data.codexSessionId,
    data.codex_session_id,
    data.sessionId,
    data.session_id,
    payload.codexSessionId,
    payload.codex_session_id,
    payload.sessionId,
    payload.session_id,
  ];
  const value = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return typeof value === 'string' ? value : '';
}
