/**
 * Answer forms for permission requests that ask for input rather than a
 * yes/no: Claude's AskUserQuestion and Codex's requestUserInput
 * (`user_input`), MCP elicitations (`elicitation`, a flat JSON schema or a
 * URL to visit) and Pi extension prompts (`extension_ui`). Moved from the
 * desktop's `ConversationRunStatus` so every client builds the same `data`
 * the daemon validates (`TodeX_backend/src/provider/types.rs`). Labels and
 * errors are left to the client: fields fall back to an empty label and
 * errors come back as codes.
 */
import type { PendingRequest, PermissionOption } from './todex';

export type PermissionAnswerData = Record<string, unknown>;

export type PermissionFieldChoice = { label: string; value: string | number | boolean; description?: string };

export type PermissionField = {
  id: string;
  /** Empty for an extension prompt without a message: the client supplies "confirm?" / "your answer". */
  label: string;
  /** Short chip title of a `user_input` question (Claude `header`). */
  header?: string;
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  required: boolean;
  multiline?: boolean;
  secret?: boolean;
  choices?: PermissionFieldChoice[];
  /** Choices accept several picks (Claude `multiSelect`); the value holds comma-joined choice indices. */
  multiple?: boolean;
  /** Choices also accept a free-text answer (`isOther`): added to the picks of a multi-select, used alone otherwise. */
  other?: boolean;
  initial?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

export type PermissionForm = {
  fields: PermissionField[];
  mode: 'elicitation' | 'user_input' | 'extension_ui' | 'url';
  /** Pi extension method: confirm, select, input or editor. */
  method?: string;
  /** `url` mode: the http(s) address the agent wants visited. */
  url?: string;
  /** The request asks for something this form cannot express: only its reject options apply. */
  unsupported?: boolean;
};

export type PermissionFormErrorCode = 'unsupported' | 'required' | 'choose' | 'integer' | 'number' | 'range' | 'length';
export type PermissionFormError = { code: PermissionFormErrorCode; label?: string };

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const hasOwn = (target: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(target, key);
const optionalNumber = (value: unknown) => typeof value === 'number' ? value : undefined;

/** The answer form `request` needs, or `null` for a plain approval. */
export function permissionForm(request: PendingRequest): PermissionForm | null {
  const details = object(request.data.details);
  const kind = string(request.data.kind);
  if (kind === 'elicitation' && details.mode === 'url') {
    let url: string | undefined;
    try {
      const parsed = new URL(string(details.url));
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href;
    } catch { /* an invalid link is never opened */ }
    return { mode: 'url', fields: [], url, unsupported: !url };
  }
  if (kind === 'elicitation') {
    const schema = object(details.requestedSchema ?? details.schema);
    const properties = object(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
    let unsupported = !Object.keys(schema).length || (schema.type !== undefined && schema.type !== 'object')
      || required.some(key => !hasOwn(properties, key));
    const fields = Object.entries(properties).flatMap(([id, raw]): PermissionField[] => {
      const property = object(raw);
      const enumValues: unknown[] | undefined = Array.isArray(property.enum) ? property.enum : property.const !== undefined ? [property.const] : undefined;
      const type = property.type ?? (enumValues?.length ? typeof enumValues[0] : 'string');
      if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean') { unsupported = true; return []; }
      const choices: PermissionFieldChoice[] = [];
      for (const value of enumValues ?? []) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') { unsupported = true; return []; }
        choices.push({ label: String(value), value });
      }
      const field: PermissionField = {
        id, label: string(property.title) || id, description: string(property.description) || undefined,
        type, required: required.includes(id), choices: enumValues ? choices : undefined,
        minimum: optionalNumber(property.minimum), maximum: optionalNumber(property.maximum),
        minLength: optionalNumber(property.minLength), maxLength: optionalNumber(property.maxLength),
      };
      if (property.default !== undefined) {
        const index = field.choices?.findIndex(choice => choice.value === property.default);
        field.initial = field.choices ? index !== undefined && index >= 0 ? String(index) : '' : String(property.default);
      }
      return [field];
    });
    return { mode: 'elicitation', fields, unsupported };
  }
  if (kind === 'user_input') {
    const questions = Array.isArray(details.questions) ? details.questions : [];
    let unsupported = !questions.length;
    const fields = questions.flatMap((raw): PermissionField[] => {
      const question = object(raw);
      const id = string(question.id);
      if (!id) { unsupported = true; return []; }
      // `isOther` adds a free-form answer next to the options; without options the text is the whole answer.
      const choices = Array.isArray(question.options) ? question.options.map((option: unknown) => {
        const item = object(option);
        const label = string(item.label) || string(option);
        return { label, value: label, description: string(item.description) || undefined };
      }).filter(option => option.label) : [];
      return [{
        id, label: string(question.question) || string(question.header) || id,
        header: string(question.header) || undefined,
        type: 'string', required: true, secret: question.isSecret === true,
        choices: choices.length ? choices : undefined,
        multiple: choices.length > 0 && question.multiSelect === true,
        other: choices.length > 0 && question.isOther === true,
      }];
    });
    return { mode: 'user_input', fields, unsupported };
  }
  if (kind === 'extension_ui') {
    const method = string(details.method);
    if (!['confirm', 'select', 'input', 'editor'].includes(method)) return { mode: 'extension_ui', method, fields: [], unsupported: true };
    const choices = method === 'select' && Array.isArray(details.options)
      ? details.options.filter((value): value is string => typeof value === 'string').map(value => ({ label: value, value }))
      : undefined;
    return {
      mode: 'extension_ui', method, unsupported: method === 'select' && !choices?.length,
      fields: [{
        id: method === 'confirm' ? 'confirmed' : 'value', label: string(details.message) || string(details.title),
        type: method === 'confirm' ? 'boolean' : 'string', required: true, choices,
        multiline: method === 'editor', initial: method === 'editor' ? string(details.prefill) : undefined,
      }],
    };
  }
  return null;
}

/** Picked choice indices of a field value (`"0,2"`). */
export function permissionFieldPicks(value: string | undefined): Set<number> {
  return new Set((value ?? '').split(',').filter(Boolean).map(Number));
}

/** Whether a field has an answer: a pick or value, or a custom answer where one is allowed. */
export function permissionFieldAnswered(field: PermissionField, values: Record<string, string>, others: Record<string, string> = {}): boolean {
  return Boolean((values[field.id] ?? '').trim()) || Boolean(field.other && (others[field.id] ?? '').trim());
}

/**
 * The `data` the daemon expects for the form's values (choice fields hold
 * choice indices, booleans `"true"`/`"false"`), or the first problem found.
 */
export function permissionFormAnswer(
  form: PermissionForm,
  values: Record<string, string>,
  others: Record<string, string> = {},
): { data: PermissionAnswerData } | { error: PermissionFormError } {
  if (form.unsupported) return { error: { code: 'unsupported' } };
  if (form.mode === 'url') return { data: { completed: true } };
  const data: PermissionAnswerData = Object.create(null) as PermissionAnswerData;
  for (const field of form.fields) {
    const text = values[field.id] ?? field.initial ?? '';
    const otherText = field.other ? (others[field.id] ?? '').trim() : '';
    const fail = (code: PermissionFormErrorCode) => ({ error: { code, label: field.label } });
    if (!text.trim()) {
      if (otherText) { data[field.id] = [otherText]; continue; }
      if (field.required) return fail('required');
      continue;
    }
    if (field.multiple && field.choices) {
      const choices = field.choices;
      const indices = text.split(',').map(Number);
      if (indices.some(index => !Number.isInteger(index) || !choices[index])) return fail('choose');
      data[field.id] = [...indices.map(index => choices[index].value), ...(otherText ? [otherText] : [])];
      continue;
    }
    let value: string | number | boolean = text;
    if (field.choices) {
      const index = Number(text);
      const choice = Number.isInteger(index) ? field.choices[index] : undefined;
      if (!choice) return fail('choose');
      value = choice.value;
    } else if (field.type === 'boolean') {
      if (text !== 'true' && text !== 'false') return fail('choose');
      value = text === 'true';
    } else if (field.type === 'number' || field.type === 'integer') {
      value = Number(text);
      if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) return fail(field.type === 'integer' ? 'integer' : 'number');
      if ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) return fail('range');
    }
    if (typeof value === 'string' && ((field.minLength !== undefined && value.length < field.minLength)
      || (field.maxLength !== undefined && value.length > field.maxLength))) return fail('length');
    data[field.id] = value;
  }
  if (form.mode === 'user_input') {
    return { data: { answers: Object.fromEntries(Object.entries(data).map(([id, value]) =>
      [id, { answers: Array.isArray(value) ? value.map(String) : [String(value)] }])) } };
  }
  return { data };
}

/** Reject, deny, decline or "reject and stop". */
export function isRejectPermissionOption(option: boolean | PermissionOption): boolean {
  return typeof option === 'boolean' ? !option : option.kind.startsWith('reject') || option.kind === 'abort_turn';
}

export function isAllowPermissionOption(option: boolean | PermissionOption): boolean {
  return typeof option === 'boolean' ? option : option.kind.startsWith('allow');
}

/** Shared option labels a client localizes; `null` keeps the backend's own name (plan review, answer choices). */
export type PermissionOptionLabel = 'approve' | 'reject' | 'rejectStop' | 'allowOnce' | 'allowSession' | 'allowConversation';

/** Backends send English option names: the shared approval ones map to a label a client can translate. */
export function permissionOptionLabel(option: boolean | PermissionOption): PermissionOptionLabel | null {
  if (typeof option === 'boolean') return option ? 'approve' : 'reject';
  if (option.kind === 'abort_turn') return 'rejectStop';
  switch (option.name) {
    case 'Allow once': return 'allowOnce';
    case 'Allow for session': return 'allowSession';
    // The agent tools' own approvals (MCP tool, desktop browser grant).
    case 'Always allow in this conversation':
    case 'Allow for this conversation': return 'allowConversation';
    case 'Reject':
    case 'Deny':
    case 'Decline': return 'reject';
    default: return null;
  }
}

/**
 * Whether rejecting with `option` may carry written feedback: a plan review
 * (`kind: "plan"`) accepts `reject_once` with `data: { feedback }`.
 */
export function permissionAcceptsFeedback(request: PendingRequest, option: boolean | PermissionOption): boolean {
  return request.data.kind === 'plan' && typeof option !== 'boolean' && option.kind === 'reject_once';
}

/** Kinds that ask the person a question rather than for approval (notification wording). */
export function isQuestionPermission(request: PendingRequest): boolean {
  const kind = string(request.data.kind);
  return kind === 'user_input' || kind === 'elicitation' || kind === 'extension_ui' || kind === 'question';
}
