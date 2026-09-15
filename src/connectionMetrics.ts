export interface ConnectionMetrics {
  connectedAt?: Date;
  reconnectCount: number;
  messagesSent: number;
  messagesReceived: number;
  lastMessageAt?: Date;
  errors: Array<{ timestamp: Date; type: string; message: string }>;
}

export class MetricsCollector {
  private metrics: ConnectionMetrics = {
    reconnectCount: 0,
    messagesSent: 0,
    messagesReceived: 0,
    errors: [],
  };

  onConnect(): void {
    if (this.metrics.connectedAt) {
      this.metrics.reconnectCount++;
    }
    this.metrics.connectedAt = new Date();
  }

  onMessageSent(): void {
    this.metrics.messagesSent++;
  }

  onMessageReceived(): void {
    this.metrics.messagesReceived++;
    this.metrics.lastMessageAt = new Date();
  }

  onError(type: string, message: string): void {
    this.metrics.errors.push({
      timestamp: new Date(),
      type,
      message,
    });
    // 保留最近100个错误
    if (this.metrics.errors.length > 100) {
      this.metrics.errors.shift();
    }
  }

  getMetrics(): Readonly<ConnectionMetrics> {
    return { ...this.metrics };
  }

  reset(): void {
    this.metrics = {
      reconnectCount: 0,
      messagesSent: 0,
      messagesReceived: 0,
      errors: [],
    };
  }
}
