import type { PromptContentRef, ConversationControlAction } from './v2';

export type CommandFrame = { id: string; type: string; payload: Record<string, unknown> };
export class CommandOutcomeUnknown extends Error {}

/** Correlate acknowledgements without retrying potentially accepted mutations. */
export class ConversationCommands {
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  send(frame: CommandFrame, send: (frame: CommandFrame) => unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.pending.has(frame.id)) return Promise.reject(new Error('请求 ID 已在等待确认，不能重复发送。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.id);
        reject(new CommandOutcomeUnknown('请求结果尚未确认，请核对会话后再发送，避免重复执行。'));
      }, timeoutMs);
      this.pending.set(frame.id, { resolve, reject, timer });
      try {
        if (!send(frame)) this.settle(frame.id, undefined, '未连接后端，请重新连接后发送。');
      } catch (error) {
        this.settle(frame.id, undefined, error instanceof Error ? error.message : '发送失败');
      }
    });
  }

  settle(id: string, result?: Record<string, unknown>, error?: string): boolean {
    const request = this.pending.get(id);
    if (!request) return false;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(new Error(error));
    else request.resolve(result ?? {});
    return true;
  }

  disconnect(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new CommandOutcomeUnknown('连接中断，请核对会话中的发送结果，避免重复执行。'));
    }
    this.pending.clear();
  }
}

export function promptContentFromAttachments(attachments: readonly { kind: string; name: string; dataUrl: string; mimeType: string; textContent?: string }[]): PromptContentRef[] {
  return attachments.map((attachment) => {
    if (attachment.kind === 'image') {
      const match = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(attachment.dataUrl);
      const data = match?.[2].replace(/\s/g, '') ?? '';
      // Reject corrupt or empty data before the composer clears its draft.
      if (match && data && data.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        return { type: 'image', data, mimeType: match[1] };
      }
    } else if (typeof attachment.textContent === 'string') {
      return { type: 'text', text: `[附件: ${attachment.name}]\n${attachment.textContent}` };
    }
    throw new Error(`无法发送附件「${attachment.name}」：当前支持图片与文本文件。请移除或转换后重试。`);
  });
}

export function controlFrame(action: ConversationControlAction, conversationId: string, payload: Record<string, unknown> = {}): Omit<CommandFrame, 'id'> {
  if (action === 'steer' || action === 'queue') {
    const expectedTurnId = typeof payload.expectedTurnId === 'string' ? payload.expectedTurnId.trim() : '';
    if (!expectedTurnId) throw new Error('实时控制需要当前运行轮次，请刷新会话后重试。');
    const input = payload.control && typeof payload.control === 'object' && !Array.isArray(payload.control)
      ? payload.control as Record<string, unknown> : payload;
    if (action === 'queue' && input.action !== undefined && !['queueAdd', 'queueRemove', 'queueList', 'queueClear'].includes(String(input.action))) {
      throw new Error('不支持的队列操作。');
    }
    if (action === 'steer' && input.action !== undefined && input.action !== 'steer') throw new Error('不支持的实时控制操作。');
    const control = action === 'steer' ? { action: 'steer', text: input.text }
      : input.action === 'queueList' || input.action === 'queueClear' ? { action: input.action }
      : input.action === 'queueRemove' ? { action: 'queueRemove', itemId: input.itemId }
      : { action: 'queueAdd', itemId: input.itemId, text: input.text };
    if ('text' in control && (typeof control.text !== 'string' || !control.text.trim())) throw new Error('请输入要发送的控制内容。');
    if ('itemId' in control && (typeof control.itemId !== 'string' || !control.itemId.trim())) throw new Error('队列操作需要消息 ID。');
    return { type: 'conversation.control', payload: { conversationId, expectedTurnId, control } };
  }
  return { type: `conversation.${action}`, payload: { ...payload, conversationId } };
}
