import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeBase64Url, deviceIdForPublicKey, encodeBase64Url } from './deviceAuth';
import { HISTORY_PUBLIC_KEY_LENGTH, historyRecipientKeyPairFromSeed } from './historyCrypto';
import { devicePairingNameFailure } from './secureChannel';

/**
 * Device groups (mesh v1, TodeX_backend docs/mesh-v1.md): signed roster
 * chains, node info, the history-key binding a joining device signs, the
 * node join-code proofs, invites and the `mesh.*` commands. Pure functions,
 * shared by every client; tests/fixtures/mesh-v1.json pins the formats
 * against the backend.
 */

export const MESH_ROSTER_DOMAIN = 'todex.mesh.v1/roster\0';
export const MESH_NODE_INFO_DOMAIN = 'todex.mesh.v1/node-info\0';
export const MESH_HISTORY_KEY_DOMAIN = 'todex.mesh.v1/history-key\0';
export const MESH_ROSTER_TYPE = 'todex.mesh.roster';
export const MESH_NODE_INFO_TYPE = 'todex.mesh.node-info';
export const MESH_RECOVERY_SIGNER = 'recovery';
export const MESH_UPDATED_EVENT = 'mesh.updated';
export const MESH_MAX_CHAIN = 4096;
export const MESH_MAX_MEMBERS = 256;
export const MESH_MAX_BODY_BYTES = 256 * 1024;
export const MESH_JOIN_CODE_LENGTH = 16;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type MeshSignedDoc = { body: string; sig: string };
export type MeshMemberKind = 'device' | 'node';
export type MeshMember = {
  id: string;
  kind: MeshMemberKind;
  name: string;
  /** Ed25519 public key, base64url. */
  publicKey: string;
  /** X-Wing history key of a device, base64url. */
  historyKey?: string;
  addedAt: number;
  addedBy: string;
};
export type MeshRecovery = { signingKey: string; historyKey: string };
export type MeshRosterBody = {
  type: typeof MESH_ROSTER_TYPE;
  v: 1;
  groupId: string | null;
  version: number;
  prev: string | null;
  nonce?: string;
  name: string;
  signer: string;
  signedAt: number;
  recovery: MeshRecovery | null;
  members: MeshMember[];
};
/** A chain that passed every rule of docs/mesh-v1.md "Roster". */
export type MeshChain = {
  groupId: string;
  docs: MeshSignedDoc[];
  bodies: MeshRosterBody[];
  head: MeshRosterBody;
  headHash: Uint8Array;
};
export type MeshNodeInfo = {
  nodeId: string;
  publicKey: string;
  seq: number;
  name: string;
  transportProtocol: 'none' | 'x25519' | 'ml-kem-768';
  transportPublicKey: string;
  urls: string[];
  signedAt: number;
};

export class MeshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeshError';
  }
}

const fail = (message: string): never => { throw new MeshError(message); };

export function meshNodeIdForPublicKey(publicKey: Uint8Array): string {
  return `node_${encodeBase64Url(sha256(publicKey).subarray(0, 12))}`;
}

function memberId(kind: MeshMemberKind, publicKey: Uint8Array): string {
  return kind === 'device' ? deviceIdForPublicKey(publicKey) : meshNodeIdForPublicKey(publicKey);
}

function decodeCanonical(value: unknown, length?: number): Uint8Array {
  if (typeof value !== 'string') return fail('expected base64url');
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(value);
  } catch {
    return fail('invalid base64url');
  }
  if (encodeBase64Url(bytes) !== value) fail('non-canonical base64url');
  if (length !== undefined && bytes.length !== length) fail('wrong key length');
  return bytes;
}

/** A strictly usable Ed25519 key: canonical, on the curve, not small order. */
export function parseMeshSigningKey(value: unknown): Uint8Array {
  const bytes = decodeCanonical(value, 32);
  try {
    if (ed25519.Point.fromBytes(bytes).isSmallOrder()) fail('weak Ed25519 key');
  } catch (error) {
    if (error instanceof MeshError) throw error;
    fail('invalid Ed25519 key');
  }
  return bytes;
}

function parseHistoryKey(value: unknown): Uint8Array {
  return decodeCanonical(value, HISTORY_PUBLIC_KEY_LENGTH);
}

function verifyDoc(doc: MeshSignedDoc, domain: string, publicKey: Uint8Array): Uint8Array {
  if (!doc || typeof doc.body !== 'string' || typeof doc.sig !== 'string') fail('malformed signed document');
  if (doc.body.length > Math.ceil(MESH_MAX_BODY_BYTES / 3) * 4) fail('document too large');
  const body = decodeCanonical(doc.body);
  const signature = decodeCanonical(doc.sig, 64);
  const message = concat(encoder.encode(domain), body);
  let valid = false;
  try {
    valid = ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    valid = false;
  }
  if (!valid) fail('signature does not verify');
  return body;
}

function parseBody(doc: MeshSignedDoc): { bytes: Uint8Array; value: Record<string, unknown> } {
  if (!doc || typeof doc.body !== 'string') return fail('malformed signed document');
  const bytes = decodeCanonical(doc.body);
  if (bytes.length > MESH_MAX_BODY_BYTES) fail('document too large');
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return fail('malformed document body');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('malformed document body');
  return { bytes, value: value as Record<string, unknown> };
}

/** Signs `body` (serialized once; readers parse these exact bytes). */
export function signMeshDoc(domain: string, body: object, secretKey: Uint8Array): MeshSignedDoc {
  const bytes = encoder.encode(JSON.stringify(body));
  const signature = ed25519.sign(concat(encoder.encode(domain), bytes), secretKey);
  return { body: encodeBase64Url(bytes), sig: encodeBase64Url(signature) };
}

function validName(name: unknown): name is string {
  return typeof name === 'string' && devicePairingNameFailure(name) === null;
}

function readRoster(value: Record<string, unknown>): MeshRosterBody {
  if (value.type !== MESH_ROSTER_TYPE || value.v !== 1) fail('not a mesh v1 roster');
  const version = value.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) fail('invalid roster version');
  if (!validName(value.name)) fail('invalid group name');
  if (typeof value.signer !== 'string' || typeof value.signedAt !== 'number') fail('invalid roster signer');
  if (!Array.isArray(value.members) || value.members.length === 0 || value.members.length > MESH_MAX_MEMBERS) {
    fail('roster must list 1-256 members');
  }
  const ids = new Set<string>();
  const members = (value.members as unknown[]).map((raw): MeshMember => {
    const member = raw as Record<string, unknown>;
    if (!member || typeof member !== 'object') return fail('malformed member');
    const kind = member.kind;
    if (kind !== 'device' && kind !== 'node') return fail('unknown member kind');
    const key = parseMeshSigningKey(member.publicKey);
    if (member.id !== memberId(kind, key)) fail('member id does not match its key');
    if (ids.has(member.id as string)) fail('roster lists a member twice');
    ids.add(member.id as string);
    if (!validName(member.name)) fail('invalid member name');
    if (kind === 'device') parseHistoryKey(member.historyKey);
    else if (member.historyKey !== undefined) fail('node members carry no history key');
    if (typeof member.addedAt !== 'number' || typeof member.addedBy !== 'string') fail('malformed member');
    return {
      id: member.id as string, kind, name: member.name as string, publicKey: member.publicKey as string,
      ...(kind === 'device' ? { historyKey: member.historyKey as string } : {}),
      addedAt: member.addedAt as number, addedBy: member.addedBy as string,
    };
  });
  if (!members.some((member) => member.kind === 'device')) fail('roster must list a device');
  let recovery: MeshRecovery | null = null;
  if (value.recovery !== null && value.recovery !== undefined) {
    const raw = value.recovery as Record<string, unknown>;
    parseMeshSigningKey(raw.signingKey);
    parseHistoryKey(raw.historyKey);
    recovery = { signingKey: raw.signingKey as string, historyKey: raw.historyKey as string };
  }
  return {
    type: MESH_ROSTER_TYPE, v: 1,
    groupId: typeof value.groupId === 'string' ? value.groupId : null,
    version: version as number, prev: typeof value.prev === 'string' ? value.prev : null,
    ...(typeof value.nonce === 'string' ? { nonce: value.nonce } : {}),
    name: value.name as string, signer: value.signer as string, signedAt: value.signedAt as number,
    recovery, members,
  };
}

function signerKey(roster: MeshRosterBody, signer: string): Uint8Array {
  if (signer === MESH_RECOVERY_SIGNER) {
    return roster.recovery ? parseMeshSigningKey(roster.recovery.signingKey) : fail('roster has no recovery key');
  }
  const member = roster.members.find((item) => item.id === signer && item.kind === 'device');
  return member ? parseMeshSigningKey(member.publicKey) : fail('signer is not a device of the group');
}

/** Verifies a chain from its genesis; throws `MeshError` on any rule. */
export function verifyMeshChain(docs: readonly MeshSignedDoc[]): MeshChain {
  if (!Array.isArray(docs) || docs.length === 0 || docs.length > MESH_MAX_CHAIN) fail('chain must hold 1-4096 documents');
  const bodies: MeshRosterBody[] = [];
  let groupId = '';
  let previousHash = new Uint8Array(32);
  docs.forEach((doc, index) => {
    const { bytes, value } = parseBody(doc);
    const body = readRoster(value);
    if (body.version !== index + 1) fail('roster versions are not consecutive');
    let key: Uint8Array;
    const previous = bodies[index - 1];
    if (!previous) {
      if (body.groupId !== null || body.prev !== null) fail('genesis must not name a group');
      if (decodeCanonical(body.nonce ?? '').length !== 16) fail('genesis needs a 16-byte nonce');
      if (body.signer === MESH_RECOVERY_SIGNER) fail('genesis must be signed by a device');
      groupId = `grp_${encodeBase64Url(sha256(bytes).subarray(0, 16))}`;
      key = signerKey(body, body.signer);
    } else {
      if (body.groupId !== groupId) fail('document belongs to another group');
      if (body.prev !== encodeBase64Url(previousHash)) fail('document does not follow its predecessor');
      key = signerKey(previous, body.signer);
    }
    verifyDoc(doc, MESH_ROSTER_DOMAIN, key);
    previousHash = sha256(bytes);
    bodies.push(body);
  });
  return { groupId, docs: [...docs], bodies, head: bodies[bodies.length - 1], headHash: previousHash };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/** The fork rule: the longer chain wins, then the smaller head hash. */
export function meshChainWins(candidate: MeshChain, current: MeshChain): boolean {
  if (candidate.docs.length !== current.docs.length) return candidate.docs.length > current.docs.length;
  return compareBytes(candidate.headHash, current.headHash) < 0;
}

export function meshChainHead(chain: MeshChain): string {
  return encodeBase64Url(chain.headHash);
}

/** A device entry for `secretKey`'s public key. */
export function meshDeviceMember(input: {
  publicKey: Uint8Array; name: string; historyKey: Uint8Array; addedBy?: string; addedAt?: number;
}): MeshMember {
  const id = deviceIdForPublicKey(input.publicKey);
  return {
    id, kind: 'device', name: input.name, publicKey: encodeBase64Url(input.publicKey),
    historyKey: encodeBase64Url(input.historyKey), addedAt: input.addedAt ?? Date.now(), addedBy: input.addedBy ?? id,
  };
}

export function meshNodeMember(input: { publicKey: Uint8Array; name: string; addedBy: string; addedAt?: number }): MeshMember {
  return {
    id: meshNodeIdForPublicKey(input.publicKey), kind: 'node', name: input.name,
    publicKey: encodeBase64Url(input.publicKey), addedAt: input.addedAt ?? Date.now(), addedBy: input.addedBy,
  };
}

/** The recovery seed (the 24 words) as roster keys: its X-Wing history key
 * and an Ed25519 signer derived with HKDF. */
export function meshRecoveryKeys(recoverySeed: Uint8Array): { signingSeed: Uint8Array; recovery: MeshRecovery } {
  const signingSeed = hkdf(sha256, recoverySeed, encoder.encode('todex.mesh.v1'), encoder.encode('todex.mesh.v1/recovery-signer'), 32);
  return {
    signingSeed,
    recovery: {
      signingKey: encodeBase64Url(ed25519.getPublicKey(signingSeed)),
      historyKey: encodeBase64Url(historyRecipientKeyPairFromSeed(recoverySeed).publicKey),
    },
  };
}

/** A new group listing only its creator. */
export function createMeshGenesis(input: {
  name: string;
  creatorSecretKey: Uint8Array;
  creatorName: string;
  creatorHistoryKey: Uint8Array;
  recovery?: MeshRecovery | null;
  now?: number;
  nonce?: Uint8Array;
}): MeshSignedDoc[] {
  const now = input.now ?? Date.now();
  const member = meshDeviceMember({
    publicKey: ed25519.getPublicKey(input.creatorSecretKey), name: input.creatorName,
    historyKey: input.creatorHistoryKey, addedAt: now,
  });
  const body: MeshRosterBody = {
    type: MESH_ROSTER_TYPE, v: 1, groupId: null, version: 1, prev: null,
    nonce: encodeBase64Url(input.nonce ?? globalThis.crypto.getRandomValues(new Uint8Array(16))),
    name: input.name, signer: member.id, signedAt: now, recovery: input.recovery ?? null, members: [member],
  };
  const docs = [signMeshDoc(MESH_ROSTER_DOMAIN, body, input.creatorSecretKey)];
  verifyMeshChain(docs);
  return docs;
}

/** Appends a version to `chain` signed by a device of its head (or the
 * recovery key with `signer: 'recovery'`); the result is verified. */
export function appendMeshRoster(chain: MeshChain, input: {
  signerSecretKey: Uint8Array;
  signer?: string;
  members?: MeshMember[];
  name?: string;
  recovery?: MeshRecovery | null;
  now?: number;
}): MeshSignedDoc[] {
  const head = chain.head;
  const signer = input.signer ?? deviceIdForPublicKey(ed25519.getPublicKey(input.signerSecretKey));
  const body: MeshRosterBody = {
    type: MESH_ROSTER_TYPE, v: 1, groupId: chain.groupId, version: head.version + 1,
    prev: encodeBase64Url(chain.headHash), name: input.name ?? head.name, signer,
    signedAt: Math.max(input.now ?? Date.now(), head.signedAt), recovery: input.recovery === undefined ? head.recovery : input.recovery,
    members: input.members ?? head.members,
  };
  const docs = [...chain.docs, signMeshDoc(MESH_ROSTER_DOMAIN, body, input.signerSecretKey)];
  verifyMeshChain(docs);
  return docs;
}

/** Verifies a node info document against the node's roster key. */
export function verifyMeshNodeInfo(doc: MeshSignedDoc, expectedPublicKey: string): MeshNodeInfo {
  const { value } = parseBody(doc);
  if (value.type !== MESH_NODE_INFO_TYPE || value.v !== 1) fail('not a mesh v1 node info');
  if (value.publicKey !== expectedPublicKey) fail('node info does not match the roster');
  const key = parseMeshSigningKey(value.publicKey);
  if (value.nodeId !== meshNodeIdForPublicKey(key)) fail('node id does not match its key');
  verifyDoc(doc, MESH_NODE_INFO_DOMAIN, key);
  const protocol = value.transportProtocol;
  if (protocol !== 'none' && protocol !== 'x25519' && protocol !== 'ml-kem-768') fail('unknown transport protocol');
  if (!Array.isArray(value.urls) || value.urls.length > 16 || !value.urls.every((url) => typeof url === 'string')) fail('invalid urls');
  if (typeof value.seq !== 'number' || typeof value.transportPublicKey !== 'string' || typeof value.name !== 'string') fail('malformed node info');
  return {
    nodeId: value.nodeId as string, publicKey: value.publicKey as string, seq: value.seq as number,
    name: value.name as string, transportProtocol: protocol as MeshNodeInfo['transportProtocol'],
    transportPublicKey: value.transportPublicKey as string, urls: value.urls as string[],
    signedAt: typeof value.signedAt === 'number' ? value.signedAt : 0,
  };
}

/** The joining device's signature binding its history key to `groupId`. */
export function meshHistoryKeySignature(deviceSecretKey: Uint8Array, groupId: string, historyKey: Uint8Array): string {
  const message = concat(encoder.encode(MESH_HISTORY_KEY_DOMAIN), encoder.encode(groupId), encoder.encode('\0'), historyKey);
  return encodeBase64Url(ed25519.sign(message, deviceSecretKey));
}

export function verifyMeshHistoryKeySignature(devicePublicKey: Uint8Array, groupId: string, historyKey: Uint8Array, signature: string): boolean {
  try {
    const message = concat(encoder.encode(MESH_HISTORY_KEY_DOMAIN), encoder.encode(groupId), encoder.encode('\0'), historyKey);
    return ed25519.verify(decodeCanonical(signature, 64), message, devicePublicKey, { zip215: false });
  } catch {
    return false;
  }
}

/** Uppercase, without `-` and whitespace, `0→O`, `1→I`, `8→B`. */
export function normalizeMeshJoinCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
}

export function isMeshJoinCode(code: string): boolean {
  return /^[A-Z2-7]{16}$/.test(normalizeMeshJoinCode(code));
}

export function meshJoinCodeKey(code: string): Uint8Array {
  return sha256(concat(encoder.encode('todex.mesh.v1/join-code\0'), encoder.encode(normalizeMeshJoinCode(code))));
}

export function meshNodeJoinClientProof(codeKey: Uint8Array, transcriptHash: Uint8Array): string {
  return encodeBase64Url(hmac(sha256, codeKey, concat(encoder.encode('todex.mesh.v1/node-join/client\0'), transcriptHash)));
}

export function meshNodeJoinServerProof(codeKey: Uint8Array, transcriptHash: Uint8Array, nodePublicKey: Uint8Array): string {
  return encodeBase64Url(hmac(sha256, codeKey, concat(encoder.encode('todex.mesh.v1/node-join/server\0'), transcriptHash, nodePublicKey)));
}

export type MeshInviteNode = { nodeId: string; name: string; urls: string[] };
export type MeshInvite = { kind: 'todex-mesh-invite'; version: 1; groupId: string; name: string; nodes: MeshInviteNode[] };

export function encodeMeshInvite(invite: Omit<MeshInvite, 'kind' | 'version'>): string {
  return JSON.stringify({ kind: 'todex-mesh-invite', version: 1, groupId: invite.groupId, name: invite.name, nodes: invite.nodes });
}

/** Parses an invite (its JSON, as a QR code or link carries it). */
export function parseMeshInvite(text: string): MeshInvite {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text.trim()) as Record<string, unknown>;
  } catch {
    return fail('not a group invite');
  }
  if (!value || value.kind !== 'todex-mesh-invite' || value.version !== 1) fail('not a group invite');
  if (typeof value.groupId !== 'string' || !/^grp_[A-Za-z0-9_-]{22}$/.test(value.groupId)) fail('invalid group id');
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > MESH_MAX_MEMBERS) fail('invite lists no backend');
  const nodes = (value.nodes as unknown[]).map((raw) => {
    const node = raw as Record<string, unknown>;
    if (!node || typeof node.nodeId !== 'string' || !Array.isArray(node.urls)) return fail('malformed invite');
    const urls = (node.urls as unknown[]).filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url)).slice(0, 16);
    const nodeId = node.nodeId as string;
    return { nodeId, name: typeof node.name === 'string' ? node.name : nodeId, urls };
  }).filter((node) => node.urls.length > 0);
  if (!nodes.length) fail('invite lists no reachable backend');
  return { kind: 'todex-mesh-invite', version: 1, groupId: value.groupId as string, name: typeof value.name === 'string' ? value.name : '', nodes };
}

export type MeshCommandFrame = { type: string; payload: Record<string, unknown> };

export const meshCommands = {
  nodeGet: (): MeshCommandFrame => ({ type: 'mesh.node.get', payload: {} }),
  stateGet: (groupId?: string): MeshCommandFrame => ({ type: 'mesh.state.get', payload: groupId ? { groupId } : {} }),
  statePush: (chain: readonly MeshSignedDoc[], nodeInfos: readonly MeshSignedDoc[] = []): MeshCommandFrame => ({
    type: 'mesh.state.push', payload: { chain, ...(nodeInfos.length ? { nodeInfos } : {}) },
  }),
  joinList: (): MeshCommandFrame => ({ type: 'mesh.join.list', payload: {} }),
  joinApprove: (requestId: string, chain: readonly MeshSignedDoc[]): MeshCommandFrame => ({
    type: 'mesh.join.approve', payload: { requestId, chain },
  }),
  joinReject: (requestId: string): MeshCommandFrame => ({ type: 'mesh.join.reject', payload: { requestId } }),
};

export type MeshNodeState = {
  nodeId: string;
  nodeInfo: MeshSignedDoc;
  groups: { groupId: string; chain: MeshSignedDoc[]; nodeInfos: MeshSignedDoc[] }[];
};

const isDoc = (value: unknown): value is MeshSignedDoc => Boolean(value)
  && typeof (value as MeshSignedDoc).body === 'string' && typeof (value as MeshSignedDoc).sig === 'string';

export function parseMeshNodeState(response: Record<string, unknown>): MeshNodeState {
  if (typeof response.nodeId !== 'string' || !isDoc(response.nodeInfo) || !Array.isArray(response.groups)) {
    fail('malformed mesh state');
  }
  return {
    nodeId: response.nodeId as string,
    nodeInfo: response.nodeInfo as MeshSignedDoc,
    groups: (response.groups as unknown[]).map((raw) => {
      const group = raw as Record<string, unknown>;
      if (!group || typeof group.groupId !== 'string' || !Array.isArray(group.chain)) return fail('malformed mesh group');
      return {
        groupId: group.groupId,
        chain: (group.chain as unknown[]).filter(isDoc),
        nodeInfos: Array.isArray(group.nodeInfos) ? (group.nodeInfos as unknown[]).filter(isDoc) : [],
      };
    }),
  };
}

export type MeshJoinRequest = {
  requestId: string;
  groupId: string;
  verificationCode: string;
  deviceName: string;
  deviceId: string;
  devicePublicKey: string;
  historyKey: string;
  peerAddress: string;
  origin?: string;
  viaProxy?: boolean;
  expiresAt: number;
};

export function parseMeshJoinRequests(response: Record<string, unknown>): MeshJoinRequest[] {
  if (!Array.isArray(response.requests)) return [];
  return (response.requests as unknown[]).flatMap((raw) => {
    const item = raw as Record<string, unknown>;
    if (!item || typeof item.requestId !== 'string' || typeof item.groupId !== 'string'
      || typeof item.verificationCode !== 'string' || typeof item.deviceId !== 'string'
      || typeof item.devicePublicKey !== 'string' || typeof item.historyKey !== 'string'
      || typeof item.expiresAt !== 'number') return [];
    return [{
      requestId: item.requestId, groupId: item.groupId, verificationCode: item.verificationCode,
      deviceName: typeof item.deviceName === 'string' ? item.deviceName : item.deviceId,
      deviceId: item.deviceId, devicePublicKey: item.devicePublicKey, historyKey: item.historyKey,
      peerAddress: typeof item.peerAddress === 'string' ? item.peerAddress : '',
      ...(typeof item.origin === 'string' ? { origin: item.origin } : {}),
      ...(item.viaProxy === true ? { viaProxy: true } : {}),
      expiresAt: item.expiresAt,
    }];
  });
}

/** The roster entry that approving `request` adds. The request's keys are
 * checked first: the device id must match its key, and the history key must
 * be the one it signed (the backend checked the signature; the device key
 * is what the verification code authenticates). */
export function meshMemberForJoinRequest(request: MeshJoinRequest, approverId: string, now = Date.now()): MeshMember {
  const publicKey = parseMeshSigningKey(request.devicePublicKey);
  if (deviceIdForPublicKey(publicKey) !== request.deviceId) fail('join request device id does not match its key');
  parseHistoryKey(request.historyKey);
  const name = validName(request.deviceName) ? request.deviceName : request.deviceId;
  return { id: request.deviceId, kind: 'device', name, publicKey: request.devicePublicKey, historyKey: request.historyKey, addedAt: now, addedBy: approverId };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
