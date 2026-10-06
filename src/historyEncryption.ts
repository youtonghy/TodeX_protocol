import {
  HISTORY_KID_LENGTH,
  HistoryContentStream,
  decodeHistoryWrappedKey,
  encodeHistoryWrappedKey,
  historyRecipientId,
  historyRecipientKeyPairFromSeed,
  openHistoryContent,
  unwrapHistoryKey,
  wrapHistoryKey,
  type HistorySegmentKey,
  type HistoryWrappedKeyJson,
} from './historyCrypto';
import { decodeBase64UrlBytes, encodeBase64Url } from './transportCrypto';
import type { TimelineEntry } from './mobileParity';

// Client side of end-to-end encrypted conversation history
// (TodeX_backend docs/history-encryption.md). The backend relays ciphertext
// untouched; this module turns `$enc` payloads back into plaintext before the
// events reach normalizeConversationEvent / the runtime projection, and holds
// the wire types and command frames of §7.

export { HISTORY_ENCRYPTION_CAPABILITY } from './v2';
/** Backend error codes this feature introduces. */
export const HISTORY_CLIENT_UPGRADE_REQUIRED = 'CLIENT_UPGRADE_REQUIRED';
export const HISTORY_STORAGE_LOW = 'STORAGE_LOW';
/** This device was revoked: every `history.*` command except
 * `history.encryption.get` fails with it until another device restores it. */
export const HISTORY_ACCESS_REVOKED = 'HISTORY_ACCESS_REVOKED';
/** Global server frame pushed when the encryption state changes. */
export const HISTORY_ENCRYPTION_UPDATED = 'history.encryption.updated';
/** `history.keys.*` / `history.grant.fulfill` batch ceiling. */
export const HISTORY_BATCH_LIMIT = 500;

export type HistoryEncryptionMode = 'off' | 'e2e';
export type HistoryDetail = 'summary' | 'full';

/** §5.3 `payload.$enc`. Event-level ciphertext carries `s`/`f`; events of a
 * sealed segment only carry `fr`, resolved against the page's `frames`. */
export type HistoryEncryptedPayload = {
  v: number;
  kid: string;
  /** Conversation id bound into the AAD (the source one after a fork). */
  c: string;
  /** Event sequence bound into the AAD (stream 1/2 counter). */
  n: number;
  s?: string;
  f?: string;
  fr?: { s?: string; f?: string; i: number };
};

/** One entry of the page-level `frames` map (§5.3), deduplicated per page. */
export type HistoryFrame = {
  kid: string;
  stream: number;
  counter: number;
  c: string;
  ct: string;
};
export type HistoryFrames = Record<string, HistoryFrame>;

/** `manifest.titleEnc` (§3.2): stream 2, counter 0 under `kid`. */
export type HistoryTitleCiphertext = { kid: string; ct: string };

export type HistoryRecipient = {
  rid: string;
  kind: 'device' | 'recovery';
  deviceId: string | null;
  publicKey: string;
  addedAt: string;
  revokedAt: string | null;
};

export type HistoryGrantStatus = 'pending' | 'fulfilled' | 'dismissed' | 'revoked';
export type HistoryGrant = {
  grantId: string;
  rid: string;
  deviceId: string;
  requestedAt: string;
  status: HistoryGrantStatus;
  /** The requesting device's history public key (base64url): the re-wrap target. */
  publicKey?: string;
};

/** This device's standing: `revoked` devices are blocked until restored. */
export type HistoryAccess = 'active' | 'unregistered' | 'revoked';
export type HistoryRevokedDevice = { deviceId: string; revokedAt: string };

/** Response of `history.encryption.get|enable|disable`, `recipient.revoke`
 * and `device.restore`. */
export type HistoryEncryptionState = {
  mode: HistoryEncryptionMode;
  epoch: number;
  recipients: HistoryRecipient[];
  myRid?: string;
  grants: HistoryGrant[];
  /** Absent from backends that predate permanent revocation. */
  myAccess?: HistoryAccess;
  revokedDevices: HistoryRevokedDevice[];
};

export type HistoryKeyRef = { conversationId: string; kid: string };
export type HistoryKeysPage = { items: HistoryKeyRef[]; nextCursor?: string };
export type HistoryGrantWrap = { conversationId: string; kid: string; wrapped: HistoryWrappedKeyJson };

export type HistoryCommandType =
  | 'history.encryption.get' | 'history.encryption.enable' | 'history.encryption.disable'
  | 'history.recipient.register' | 'history.recipient.revoke' | 'history.recovery.set'
  | 'history.grant.request' | 'history.grant.list' | 'history.grant.dismiss' | 'history.grant.fulfill'
  | 'history.keys.list' | 'history.keys.wraps' | 'history.device.restore';

export type HistoryCommandFrame = { type: HistoryCommandType; payload: Record<string, unknown> };
/** Sends one §7 command over the v2 socket and resolves its result payload. */
export type HistoryCommandSender = (frame: HistoryCommandFrame) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Command frames (§7)

export const historyCommands = {
  get: (): HistoryCommandFrame => ({ type: 'history.encryption.get', payload: {} }),
  enable: (): HistoryCommandFrame => ({ type: 'history.encryption.enable', payload: {} }),
  disable: (): HistoryCommandFrame => ({ type: 'history.encryption.disable', payload: {} }),
  register: (publicKey: Uint8Array): HistoryCommandFrame => ({
    type: 'history.recipient.register', payload: { publicKey: encodeBase64Url(publicKey) },
  }),
  revoke: (rid: string): HistoryCommandFrame => ({ type: 'history.recipient.revoke', payload: { rid: requireText(rid, '接收方') } }),
  /** Lifts a revoked device's block; it then registers a fresh key. */
  restoreDevice: (deviceId: string): HistoryCommandFrame => ({
    type: 'history.device.restore', payload: { deviceId: requireText(deviceId, '设备') },
  }),
  setRecovery: (publicKey: Uint8Array): HistoryCommandFrame => ({
    type: 'history.recovery.set', payload: { publicKey: encodeBase64Url(publicKey) },
  }),
  requestGrant: (): HistoryCommandFrame => ({ type: 'history.grant.request', payload: {} }),
  listGrants: (): HistoryCommandFrame => ({ type: 'history.grant.list', payload: {} }),
  dismissGrant: (grantId: string): HistoryCommandFrame => ({
    type: 'history.grant.dismiss', payload: { grantId: requireText(grantId, '授权请求') },
  }),
  listKeys: (options: { conversationId?: string; cursor?: string; limit?: number } = {}): HistoryCommandFrame => ({
    type: 'history.keys.list',
    payload: {
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      limit: Math.min(HISTORY_BATCH_LIMIT, Math.max(1, Math.floor(options.limit ?? HISTORY_BATCH_LIMIT))),
    },
  }),
  wraps: (conversationId: string, kids: readonly string[], rid?: string): HistoryCommandFrame => {
    if (!kids.length || kids.length > HISTORY_BATCH_LIMIT) throw new Error(`每次最多查询 ${HISTORY_BATCH_LIMIT} 个密钥`);
    return {
      type: 'history.keys.wraps',
      payload: { conversationId: requireText(conversationId, '会话'), kids: [...kids], ...(rid ? { rid } : {}) },
    };
  },
  /** `complete` marks a grant's last batch (it may then carry no wraps). */
  fulfill: (rid: string, wraps: readonly HistoryGrantWrap[], grantId?: string, complete = false): HistoryCommandFrame => {
    if ((!wraps.length && !complete) || wraps.length > HISTORY_BATCH_LIMIT) throw new Error(`每批最多上传 ${HISTORY_BATCH_LIMIT} 个密钥`);
    return {
      type: 'history.grant.fulfill',
      payload: { ...(grantId ? { grantId } : {}), rid: requireText(rid, '接收方'), wraps: [...wraps], ...(complete ? { complete: true } : {}) },
    };
  },
};

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少${label} ID`);
  return value;
}

// ---------------------------------------------------------------------------
// Response parsing

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const optionalString = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

export function parseHistoryEncryptionState(value: unknown): HistoryEncryptionState {
  const source = record(value);
  if (!source || (source.mode !== 'off' && source.mode !== 'e2e')) throw new Error('历史加密状态格式无效');
  const recipients = Array.isArray(source.recipients) ? source.recipients.flatMap((item): HistoryRecipient[] => {
    const entry = record(item);
    if (!entry || typeof entry.rid !== 'string' || typeof entry.publicKey !== 'string') return [];
    return [{
      rid: entry.rid,
      kind: entry.kind === 'recovery' ? 'recovery' : 'device',
      deviceId: optionalString(entry.deviceId),
      publicKey: entry.publicKey,
      addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : '',
      revokedAt: optionalString(entry.revokedAt),
    }];
  }) : [];
  return {
    mode: source.mode,
    epoch: typeof source.epoch === 'number' ? source.epoch : 0,
    recipients,
    ...(typeof source.myRid === 'string' && source.myRid ? { myRid: source.myRid } : {}),
    grants: parseHistoryGrants(source.grants),
    ...(HISTORY_ACCESS.has(source.myAccess as HistoryAccess) ? { myAccess: source.myAccess as HistoryAccess } : {}),
    revokedDevices: Array.isArray(source.revokedDevices) ? source.revokedDevices.flatMap((item): HistoryRevokedDevice[] => {
      const entry = record(item);
      return entry && typeof entry.deviceId === 'string' && entry.deviceId
        ? [{ deviceId: entry.deviceId, revokedAt: typeof entry.revokedAt === 'string' ? entry.revokedAt : '' }] : [];
    }) : [],
  };
}

const HISTORY_ACCESS: ReadonlySet<HistoryAccess> = new Set(['active', 'unregistered', 'revoked']);

// ---------------------------------------------------------------------------
// Pushed updates

/** Why `history.encryption.updated` was pushed. Unknown reasons still mean
 * the state changed. */
export type HistoryUpdateReason =
  | 'mode' | 'recipient.registered' | 'recipient.revoked' | 'device.restored' | 'device.revoked'
  | 'recovery.set' | 'grant.requested' | 'grant.dismissed' | 'grant.progress' | 'grant.fulfilled';

/** Payload of the global `history.encryption.updated` frame; never carries
 * key material. */
export type HistoryEncryptionUpdate = {
  epoch: number;
  mode: HistoryEncryptionMode;
  reason: HistoryUpdateReason | (string & {});
  /** Grant events: the recipient that received wraps. */
  rid?: string;
  deviceId?: string;
  grantId?: string;
  /** `grant.progress`: conversations that received new wraps. */
  conversationIds?: string[];
};

export function parseHistoryEncryptionUpdate(value: unknown): HistoryEncryptionUpdate | null {
  const source = record(value);
  if (!source || typeof source.reason !== 'string' || (source.mode !== 'off' && source.mode !== 'e2e')) return null;
  const text = (key: 'rid' | 'deviceId' | 'grantId') => (typeof source[key] === 'string' && source[key] ? { [key]: source[key] as string } : {});
  return {
    epoch: typeof source.epoch === 'number' ? source.epoch : 0,
    mode: source.mode,
    reason: source.reason,
    ...text('rid'), ...text('deviceId'), ...text('grantId'),
    ...(Array.isArray(source.conversationIds)
      ? { conversationIds: source.conversationIds.filter((id): id is string => typeof id === 'string' && Boolean(id)) } : {}),
  };
}

/** What an update means for this device: the state is always re-read; when
 * wraps arrived for one of `localRids`, `unlock` names the conversations to
 * re-decrypt (`'all'`: every loaded encrypted one) after forgetting the
 * decryptor's negative cache. */
export type HistoryUpdateReaction = { unlock: readonly string[] | 'all' | null };

export function historyUpdateReaction(update: HistoryEncryptionUpdate, localRids: readonly (string | undefined)[]): HistoryUpdateReaction {
  const grant = update.reason === 'grant.progress' || update.reason === 'grant.fulfilled';
  if (!grant || !update.rid || !localRids.includes(update.rid)) return { unlock: null };
  return { unlock: update.conversationIds ?? 'all' };
}

const GRANT_STATUSES: ReadonlySet<HistoryGrantStatus> = new Set(['pending', 'fulfilled', 'dismissed', 'revoked']);

export function parseHistoryGrants(value: unknown): HistoryGrant[] {
  return Array.isArray(value) ? value.flatMap((item): HistoryGrant[] => {
    const entry = record(item);
    if (!entry || typeof entry.grantId !== 'string' || typeof entry.rid !== 'string') return [];
    // A status this client does not know is never offered as actionable.
    if (entry.status !== undefined && !GRANT_STATUSES.has(entry.status as HistoryGrantStatus)) return [];
    return [{
      grantId: entry.grantId,
      rid: entry.rid,
      deviceId: typeof entry.deviceId === 'string' ? entry.deviceId : '',
      requestedAt: typeof entry.requestedAt === 'string' ? entry.requestedAt : '',
      status: (entry.status as HistoryGrantStatus | undefined) ?? 'pending',
      ...(typeof entry.publicKey === 'string' && entry.publicKey ? { publicKey: entry.publicKey } : {}),
    }];
  }) : [];
}

function parseKeysPage(value: Record<string, unknown>): HistoryKeysPage {
  const items = Array.isArray(value.items) ? value.items.flatMap((item): HistoryKeyRef[] => {
    const entry = record(item);
    return entry && typeof entry.conversationId === 'string' && typeof entry.kid === 'string'
      ? [{ conversationId: entry.conversationId, kid: entry.kid }] : [];
  }) : [];
  return { items, ...(typeof value.nextCursor === 'string' && value.nextCursor ? { nextCursor: value.nextCursor } : {}) };
}

function parseWraps(value: Record<string, unknown>): Record<string, HistoryWrappedKeyJson> {
  const wraps = record(value.wraps) ?? {};
  const result: Record<string, HistoryWrappedKeyJson> = {};
  for (const [kid, wrap] of Object.entries(wraps)) {
    const entry = record(wrap);
    if (entry && typeof entry.rid === 'string' && typeof entry.kemCt === 'string' && typeof entry.wrapped === 'string') {
      result[kid] = { rid: entry.rid, kemCt: entry.kemCt, wrapped: entry.wrapped };
    }
  }
  return result;
}

/** `history.keys.wraps` through a command sender, as HistoryDecryptor wants it. */
export function historyWrapsFetcher(send: HistoryCommandSender): HistoryWrapsFetcher {
  return async ({ conversationId, kids, rid }) => parseWraps(await send(historyCommands.wraps(conversationId, kids, rid)));
}

// ---------------------------------------------------------------------------
// Decryption

/** Fetches this conversation's wrapped DEKs addressed to `rid`; kids without
 * a wrap for `rid` are simply absent. Transport failures should throw: the
 * page then fails and is retried instead of being projected as locked. */
export type HistoryWrapsFetcher = (request: { conversationId: string; kids: string[]; rid: string }) => Promise<Record<string, HistoryWrappedKeyJson>>;

export type HistoryDecryptorOptions = {
  /** X-Wing seeds that may hold wraps: this device's own first, then e.g. an
   * imported recovery seed. Copied; `clear()` zeroes the copies. */
  seeds?: readonly Uint8Array[];
  fetchWraps: HistoryWrapsFetcher;
  /** Unwrapped DEKs kept (LRU). Default 512. */
  maxKeys?: number;
  /** How long a kid without a usable wrap stays locked before it is asked
   * for again. Default 30 s; `forgetMissing()` clears it at once. */
  missingTtlMs?: number;
  /** Inflates a decrypted frame: sealed frames are always raw DEFLATE
   * (RFC 1951) of the JSON payload array (§4.3). Defaults to
   * `DecompressionStream('deflate-raw')`. */
  inflateFrame?: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  now?: () => number;
};

/** Events as they come off the wire, before normalizeConversationEvent. */
export type HistoryWireEvent = { conversationId?: unknown; sequence?: unknown; payload?: unknown; [key: string]: unknown };
export type HistoryWirePage<E extends HistoryWireEvent = HistoryWireEvent> = { conversationId?: unknown; events: E[]; frames?: unknown; [key: string]: unknown };

type CachedKey = { key: HistorySegmentKey } | { missingUntil: number };

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Does this payload carry ciphertext? */
export function isHistoryEncryptedPayload(payload: unknown): boolean {
  return Boolean(record(record(payload)?.$enc));
}

/** Any event of the batch still needs decrypting. */
export function historyEventsNeedDecryption(events: readonly HistoryWireEvent[]): boolean {
  return events.some((event) => isHistoryEncryptedPayload(event?.payload));
}

/** Decrypts `$enc` payloads of history pages and live events. Never drops
 * or reorders events: one that cannot be opened keeps its envelope fields
 * plus `detailLocked: true` so sequences stay contiguous. */
export class HistoryDecryptor {
  private seeds: { seed: Uint8Array; rid: string }[] = [];
  private readonly keys = new Map<string, CachedKey>();
  private readonly fetchWraps: HistoryWrapsFetcher;
  private readonly maxKeys: number;
  private readonly missingTtlMs: number;
  private readonly inflateFrame?: HistoryDecryptorOptions['inflateFrame'];
  private readonly now: () => number;
  /** Single-flight key fetches per conversation+kid. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Recently opened frames. Socket backfill attaches the same frame to every
   * message referring to it and each message is decrypted on its own, so
   * without this a ~1 MiB frame is opened and inflated once per event. Reused
   * only for a byte-identical frame under the same conversation. */
  private recentFrames: { scope: string; frame: HistoryFrame; items: Promise<unknown[] | null> }[] = [];

  constructor(options: HistoryDecryptorOptions) {
    this.fetchWraps = options.fetchWraps;
    this.maxKeys = Math.max(1, options.maxKeys ?? 512);
    this.missingTtlMs = options.missingTtlMs ?? 30_000;
    this.inflateFrame = options.inflateFrame;
    this.now = options.now ?? Date.now;
    this.setSeeds(options.seeds ?? []);
  }

  /** Recipient ids this decryptor can open wraps for, in lookup order. */
  get recipientIds(): string[] { return this.seeds.map((entry) => entry.rid); }

  setSeeds(seeds: readonly Uint8Array[]): void {
    for (const entry of this.seeds) entry.seed.fill(0);
    const seen = new Set<string>();
    this.seeds = seeds.flatMap((seed) => {
      const { publicKey, secretKey } = historyRecipientKeyPairFromSeed(seed);
      const rid = encodeBase64Url(historyRecipientId(publicKey));
      if (seen.has(rid)) { secretKey.fill(0); return []; }
      seen.add(rid);
      return [{ seed: secretKey, rid }];
    });
    this.forgetMissing();
  }

  /** New grants or seeds may unlock kids that had no wrap before. */
  forgetMissing(): void {
    for (const [cacheKey, entry] of this.keys) if ('missingUntil' in entry) this.keys.delete(cacheKey);
  }

  /** Zeroes and forgets every DEK and seed. */
  clear(): void {
    this.recentFrames = [];
    for (const entry of this.keys.values()) if ('key' in entry) entry.key.dek.fill(0);
    this.keys.clear();
    for (const entry of this.seeds) entry.seed.fill(0);
    this.seeds = [];
  }

  /** The unwrapped DEK of `kid` in `conversationId`, fetching its wrap when
   * needed; `null` when no seed of this device can open it. */
  async segmentKey(conversationId: string, kid: string): Promise<HistorySegmentKey | null> {
    await this.ensureKeys(conversationId, [kid]);
    return this.cachedKey(conversationId, kid);
  }

  /** Decrypts a history page (`events` + optional `frames`) and drops the
   * consumed `frames` map. Pages without ciphertext come back unchanged. */
  async decryptPage<P extends HistoryWirePage>(page: P, detail: HistoryDetail, conversationId?: string): Promise<P> {
    const frames = parseFrames(page.frames);
    if (!historyEventsNeedDecryption(page.events)) return page;
    const scope = conversationId ?? (typeof page.conversationId === 'string' ? page.conversationId : '');
    const events = await this.decryptEvents(page.events, { frames, detail, conversationId: scope });
    const { frames: _frames, ...rest } = page;
    return { ...rest, events } as P;
  }

  /** Async form for any batch: fetches missing wraps first. */
  async decryptEvents<E extends HistoryWireEvent>(events: readonly E[], options: { frames?: HistoryFrames; detail: HistoryDetail; conversationId?: string }): Promise<E[]> {
    const pending = new Map<string, Set<string>>();
    for (const event of events) {
      const scope = eventScope(event, options.conversationId);
      for (const kid of this.kidsOf(event, options.frames ?? {}, options.detail)) {
        if (this.cachedEntry(scope, kid)) continue;
        let kids = pending.get(scope);
        if (!kids) pending.set(scope, kids = new Set());
        kids.add(kid);
      }
    }
    await Promise.all([...pending].map(([scope, kids]) => this.ensureKeys(scope, [...kids])));
    return this.openEvents(events, options);
  }

  /** Synchronous form for live frames: `null` when a wrap must be fetched
   * first (use decryptEvents then). */
  tryDecryptEvents<E extends HistoryWireEvent>(events: readonly E[], options: { frames?: HistoryFrames; detail: HistoryDetail; conversationId?: string }): E[] | null {
    for (const event of events) {
      const scope = eventScope(event, options.conversationId);
      if (this.kidsOf(event, options.frames ?? {}, options.detail).some((kid) => !this.cachedEntry(scope, kid))) return null;
      // Frame plaintext is inflated asynchronously.
      if (record(record(record(event.payload)?.$enc)?.fr)) return null;
    }
    return this.openEventsSync(events, options);
  }

  /** `manifest.titleEnc` → title text; `null` when this device cannot read it. */
  async decryptTitle(conversationId: string, titleEnc: HistoryTitleCiphertext | null | undefined): Promise<string | null> {
    if (!titleEnc || typeof titleEnc.kid !== 'string' || typeof titleEnc.ct !== 'string') return null;
    const key = await this.segmentKey(conversationId, titleEnc.kid);
    if (!key) return null;
    try {
      return decoder.decode(openHistoryContent(key, conversationId, HistoryContentStream.EventFull, 0, decodeBase64UrlBytes(titleEnc.ct)));
    } catch {
      return null;
    }
  }

  private async openEvents<E extends HistoryWireEvent>(events: readonly E[], options: { frames?: HistoryFrames; detail: HistoryDetail; conversationId?: string }): Promise<E[]> {
    const opened = new Map<string, Promise<unknown[] | null>>();
    const frames = options.frames ?? {};
    return Promise.all(events.map(async (event) => {
      const payload = record(event.payload);
      const enc = record(payload?.$enc);
      if (!payload || !enc) return event;
      const scope = eventScope(event, options.conversationId);
      const frameRef = record(enc.fr);
      if (!frameRef) return this.withPayload(event, payload, this.openEventLevel(scope, enc, options.detail));
      const frameId = pickFrame(frameRef, frames, options.detail);
      const index = frameRef.i;
      if (!frameId || typeof index !== 'number' || !Number.isInteger(index) || index < 0) return this.withPayload(event, payload, null);
      let items = opened.get(frameId);
      if (!items) opened.set(frameId, items = this.openFrame(scope, frames[frameId]));
      const item = (await items)?.[index];
      return this.withPayload(event, payload, record(item));
    }));
  }

  private openEventsSync<E extends HistoryWireEvent>(events: readonly E[], options: { detail: HistoryDetail; conversationId?: string }): E[] {
    return events.map((event) => {
      const payload = record(event.payload);
      const enc = record(payload?.$enc);
      if (!payload || !enc) return event;
      return this.withPayload(event, payload, this.openEventLevel(eventScope(event, options.conversationId), enc, options.detail));
    });
  }

  private openEventLevel(scope: string, enc: Record<string, unknown>, detail: HistoryDetail): Record<string, unknown> | null {
    if (enc.v !== 1 || typeof enc.kid !== 'string' || typeof enc.c !== 'string' || typeof enc.n !== 'number') return null;
    const summary = typeof enc.s === 'string' ? enc.s : undefined;
    const full = typeof enc.f === 'string' ? enc.f : undefined;
    // `s` omitted means summary and full are the same stream-2 ciphertext.
    const useFull = full !== undefined && (detail === 'full' || summary === undefined);
    const ciphertext = useFull ? full : summary;
    const key = this.cachedKey(scope, enc.kid);
    if (!ciphertext || !key) return null;
    try {
      const plaintext = openHistoryContent(key, enc.c, useFull ? HistoryContentStream.EventFull : HistoryContentStream.EventSummary, enc.n, decodeBase64UrlBytes(ciphertext));
      return record(JSON.parse(decoder.decode(plaintext)));
    } catch {
      return null;
    }
  }

  private openFrame(scope: string, frame: HistoryFrame | undefined): Promise<unknown[] | null> {
    if (!frame) return Promise.resolve(null);
    const hit = this.recentFrames.find((entry) => entry.scope === scope && sameFrame(entry.frame, frame));
    if (hit) return hit.items;
    const items = this.openFrameUncached(scope, frame);
    // A frame that could not be opened (key not here yet) is asked again.
    void items.then((opened) => {
      if (!opened) this.recentFrames = this.recentFrames.filter((entry) => entry.items !== items);
    });
    this.recentFrames = [{ scope, frame, items }, ...this.recentFrames].slice(0, RECENT_FRAMES);
    return items;
  }

  private async openFrameUncached(scope: string, frame: HistoryFrame): Promise<unknown[] | null> {
    const key = this.cachedKey(scope, frame.kid);
    if (!key || (frame.stream !== HistoryContentStream.FrameSummary && frame.stream !== HistoryContentStream.FrameFull)) return null;
    try {
      const compressed = openHistoryContent(key, frame.c, frame.stream, frame.counter, decodeBase64UrlBytes(frame.ct));
      const items: unknown = JSON.parse(decoder.decode(await this.inflate(compressed)));
      return Array.isArray(items) ? items : null;
    } catch {
      return null;
    }
  }

  private async inflate(bytes: Uint8Array): Promise<Uint8Array> {
    if (this.inflateFrame) return this.inflateFrame(bytes);
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  private withPayload<E extends HistoryWireEvent>(event: E, payload: Record<string, unknown>, plaintext: Record<string, unknown> | null): E {
    if (plaintext) return { ...event, payload: plaintext };
    const { $enc: _enc, ...envelope } = payload;
    return { ...event, payload: { ...envelope, detailLocked: true } };
  }

  /** Kids an event needs under `detail`. */
  private kidsOf(event: HistoryWireEvent, frames: HistoryFrames, detail: HistoryDetail): string[] {
    const enc = record(record(event.payload)?.$enc);
    if (!enc) return [];
    const frameRef = record(enc.fr);
    if (frameRef) {
      const frameId = pickFrame(frameRef, frames, detail);
      return frameId ? [frames[frameId].kid] : [];
    }
    return typeof enc.kid === 'string' ? [enc.kid] : [];
  }

  private cachedEntry(scope: string, kid: string): CachedKey | undefined {
    const cacheKey = `${scope}\0${kid}`;
    const entry = this.keys.get(cacheKey);
    if (!entry) return undefined;
    if ('missingUntil' in entry) {
      if (entry.missingUntil > this.now()) return entry;
      this.keys.delete(cacheKey);
      return undefined;
    }
    // LRU touch.
    this.keys.delete(cacheKey);
    this.keys.set(cacheKey, entry);
    return entry;
  }

  private cachedKey(scope: string, kid: string): HistorySegmentKey | null {
    const entry = this.cachedEntry(scope, kid);
    return entry && 'key' in entry ? entry.key : null;
  }

  private remember(scope: string, kid: string, entry: CachedKey): void {
    const cacheKey = `${scope}\0${kid}`;
    const previous = this.keys.get(cacheKey);
    if (previous && 'key' in previous && previous !== entry) previous.key.dek.fill(0);
    this.keys.delete(cacheKey);
    this.keys.set(cacheKey, entry);
    while (this.keys.size > this.maxKeys) {
      const [oldest, evicted] = this.keys.entries().next().value as [string, CachedKey];
      if ('key' in evicted) evicted.key.dek.fill(0);
      this.keys.delete(oldest);
    }
  }

  /** Fetch and unwrap the kids not cached yet: per seed in order, in
   * batches, each kid single-flight. */
  private async ensureKeys(scope: string, kids: readonly string[]): Promise<void> {
    const waits: Promise<void>[] = [];
    const wanted: string[] = [];
    for (const kid of new Set(kids)) {
      if (this.cachedEntry(scope, kid)) continue;
      const running = this.inflight.get(`${scope}\0${kid}`);
      if (running) waits.push(running);
      else wanted.push(kid);
    }
    if (wanted.length) {
      const work = this.fetchKeys(scope, wanted);
      for (const kid of wanted) this.inflight.set(`${scope}\0${kid}`, work);
      waits.push(work.finally(() => {
        for (const kid of wanted) if (this.inflight.get(`${scope}\0${kid}`) === work) this.inflight.delete(`${scope}\0${kid}`);
      }));
    }
    await Promise.all(waits);
  }

  private async fetchKeys(scope: string, kids: readonly string[]): Promise<void> {
    let remaining = kids.filter(isKidText);
    for (const kid of kids) if (!isKidText(kid)) this.remember(scope, kid, { missingUntil: this.now() + this.missingTtlMs });
    for (const { seed, rid } of this.seeds) {
      if (!remaining.length) break;
      const unresolved: string[] = [];
      for (let offset = 0; offset < remaining.length; offset += HISTORY_BATCH_LIMIT) {
        const batch = remaining.slice(offset, offset + HISTORY_BATCH_LIMIT);
        const wraps = await this.fetchWraps({ conversationId: scope, kids: batch, rid });
        for (const kid of batch) {
          const key = wraps[kid] ? unwrapWith(seed, wraps[kid], kid) : null;
          if (key) this.remember(scope, kid, { key });
          else unresolved.push(kid);
        }
      }
      remaining = unresolved;
    }
    const missingUntil = this.now() + this.missingTtlMs;
    for (const kid of remaining) this.remember(scope, kid, { missingUntil });
  }
}

/** Opened frames kept for reuse across separately decrypted messages. */
const RECENT_FRAMES = 2;

function sameFrame(a: HistoryFrame, b: HistoryFrame): boolean {
  return a.kid === b.kid && a.stream === b.stream && a.counter === b.counter && a.c === b.c && a.ct === b.ct;
}

function eventScope(event: HistoryWireEvent, fallback?: string): string {
  return fallback || (typeof event.conversationId === 'string' ? event.conversationId : '');
}

function isKidText(kid: string): boolean {
  try {
    return decodeBase64UrlBytes(kid).length === HISTORY_KID_LENGTH;
  } catch {
    return false;
  }
}

function unwrapWith(seed: Uint8Array, wrapped: HistoryWrappedKeyJson, kid: string): HistorySegmentKey | null {
  try {
    return unwrapHistoryKey(seed, decodeHistoryWrappedKey(wrapped), decodeBase64UrlBytes(kid));
  } catch {
    return null;
  }
}

/** Under `summary` prefer the summary frame, under `full` the full one;
 * either way only a frame the page actually carries. */
function pickFrame(frameRef: Record<string, unknown>, frames: HistoryFrames, detail: HistoryDetail): string | null {
  const order = detail === 'full' ? [frameRef.f, frameRef.s] : [frameRef.s, frameRef.f];
  for (const id of order) if (typeof id === 'string' && frames[id]) return id;
  return null;
}

/** Validates a page's `frames` map; malformed entries are skipped (the events
 * referring to them then come out locked). */
export function parseFrames(value: unknown): HistoryFrames {
  const source = record(value);
  const result: HistoryFrames = {};
  if (!source) return result;
  for (const [id, frame] of Object.entries(source)) {
    const entry = record(frame);
    if (entry && typeof entry.kid === 'string' && typeof entry.stream === 'number' && typeof entry.counter === 'number'
      && typeof entry.c === 'string' && typeof entry.ct === 'string') {
      result[id] = { kid: entry.kid, stream: entry.stream, counter: entry.counter, c: entry.c, ct: entry.ct };
    }
  }
  return result;
}

/** The text `conversation.retry` must carry while history is encrypted (§7):
 * the latest user message of a runtime timeline, which is newest-first.
 * `null` when that message is locked on this device or empty, since the
 * backend only accepts the exact original text. */
export function historyRetryPrompt(timeline: readonly Pick<TimelineEntry, 'kind' | 'subtitle' | 'detailLocked'>[]): string | null {
  const latest = timeline.find((entry) => entry.kind === 'outgoing');
  return latest && !latest.detailLocked && latest.subtitle.trim() ? latest.subtitle : null;
}

/** The original request an encrypted user `message.created` carries for
 * retries (§7): the trimmed text and the original `content` items. Summary
 * pages leave it out, so it is read from the message in full detail. */
export type HistoryRetryRequest = { text: string; content: unknown[] };

/** `retryRequest` of a decrypted user message payload, or `null` when the
 * message predates it or is not readable. */
export function historyRetryRequest(payload: unknown): HistoryRetryRequest | null {
  const request = record(record(payload)?.retryRequest);
  if (!request || typeof request.text !== 'string' || !Array.isArray(request.content)) return null;
  return { text: request.text, content: request.content };
}

/** Sequence of the latest user message of a newest-first runtime timeline,
 * to fetch in full detail for its `retryRequest`; `null` when that message
 * is locked on this device (projected empty) or has no sequence. */
export function historyRetrySequence(timeline: readonly Pick<TimelineEntry, 'kind' | 'subtitle' | 'detailLocked' | 'sequence'>[]): number | null {
  const latest = timeline.find((entry) => entry.kind === 'outgoing');
  return latest && !latest.detailLocked && latest.subtitle.trim() && typeof latest.sequence === 'number' ? latest.sequence : null;
}

// ---------------------------------------------------------------------------
// Grants and recovery (§3.3)

export type HistoryRewrapProgress = {
  /** Keys listed so far. */
  processed: number;
  /** Wraps the backend accepted (`added`). */
  added: number;
  /** Keys the source seed holds no wrap for. */
  skipped: number;
  /** Resume point for `history.keys.list`; absent once finished. */
  cursor?: string;
};

export type HistoryRewrapOptions = {
  send: HistoryCommandSender;
  /** Seed whose wraps are read: this device's, or an imported recovery seed. */
  sourceSeed: Uint8Array;
  /** Recipient that receives the new wraps. */
  targetPublicKey: Uint8Array;
  /** Omitted for the recovery self-grant; with it the last batch is sent
   * with `complete: true`. */
  grantId?: string;
  /** Continue an interrupted run from this `keys.list` cursor. */
  cursor?: string;
  onProgress?: (progress: HistoryRewrapProgress) => void;
  signal?: AbortSignal;
  /** Keys per list page and per fulfill batch (≤ 500). */
  batchSize?: number;
};

/** Re-wraps every DEK the source seed can open for the target recipient:
 * `keys.list` → `keys.wraps` (source rid) → unwrap → wrap for target →
 * `grant.fulfill`, one list page at a time. Progress reports the cursor after
 * each committed page so an interrupted run can resume there. */
export async function rewrapHistoryKeys(options: HistoryRewrapOptions): Promise<HistoryRewrapProgress> {
  const batchSize = Math.min(HISTORY_BATCH_LIMIT, Math.max(1, Math.floor(options.batchSize ?? HISTORY_BATCH_LIMIT)));
  const source = historyRecipientKeyPairFromSeed(options.sourceSeed);
  const sourceRid = encodeBase64Url(historyRecipientId(source.publicKey));
  const targetRid = encodeBase64Url(historyRecipientId(options.targetPublicKey));
  const progress: HistoryRewrapProgress = { processed: 0, added: 0, skipped: 0, ...(options.cursor ? { cursor: options.cursor } : {}) };
  const checkAbort = () => {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  try {
    for (;;) {
      checkAbort();
      const page = parseKeysPage(await options.send(historyCommands.listKeys({ cursor: progress.cursor, limit: batchSize })));
      const byConversation = new Map<string, string[]>();
      for (const item of page.items) {
        const kids = byConversation.get(item.conversationId) ?? [];
        kids.push(item.kid);
        byConversation.set(item.conversationId, kids);
      }
      const rewrapped: HistoryGrantWrap[] = [];
      for (const [conversationId, kids] of byConversation) {
        checkAbort();
        const wraps = parseWraps(await options.send(historyCommands.wraps(conversationId, kids, sourceRid)));
        for (const kid of kids) {
          const key = wraps[kid] ? unwrapWith(source.secretKey, wraps[kid], kid) : null;
          if (!key) { progress.skipped++; continue; }
          try {
            rewrapped.push({ conversationId, kid, wrapped: encodeHistoryWrappedKey(wrapHistoryKey(key, options.targetPublicKey)) });
          } finally {
            key.dek.fill(0);
          }
        }
      }
      // A grant's last batch says so (`complete`), even when it is empty.
      const finishing = !page.nextCursor && Boolean(options.grantId);
      for (let offset = 0; offset < rewrapped.length || (finishing && offset === 0); offset += batchSize) {
        checkAbort();
        const batch = rewrapped.slice(offset, offset + batchSize);
        const complete = finishing && offset + batchSize >= rewrapped.length;
        const result = await options.send(historyCommands.fulfill(targetRid, batch, options.grantId, complete));
        progress.added += typeof result.added === 'number' ? result.added : 0;
      }
      progress.processed += page.items.length;
      if (page.nextCursor) progress.cursor = page.nextCursor;
      else delete progress.cursor;
      options.onProgress?.({ ...progress });
      if (!page.nextCursor) return progress;
    }
  } finally {
    source.secretKey.fill(0);
  }
}
