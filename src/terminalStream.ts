/**
 * Terminal output held outside UI state. The session writes backend output
 * here and the terminal view subscribes, so output never re-renders the app;
 * a view that mounts later starts from `snapshot()`.
 *
 * Output from backends with `terminalReplay` carries a per-terminal `seq`.
 * Duplicates are dropped; a gap stops applying output until the session
 * attaches again and `applyAttached` fills it (or resets).
 */

/** Output kept per terminal for views that mount later. */
export const TERMINAL_STREAM_LIMIT = 2 * 1024 * 1024;

export type TerminalStreamUpdate =
  | { kind: 'data'; data: string }
  /** Clear the view, then write `data`. */
  | { kind: 'reset'; data: string };

export type TerminalStreamListener = (update: TerminalStreamUpdate) => void;

export type TerminalOutputResult = 'applied' | 'duplicate' | 'gap' | 'waiting';

export type TerminalAttachedOutput = { reset: boolean; data: string; seq: number };

export class TerminalStream {
  private chunks: string[] = [];
  private length = 0;
  private listeners = new Set<TerminalStreamListener>();
  /** Last applied `seq`; 0 before any sequenced output. */
  seq = 0;
  /** A gap was seen: live output waits for the next attach. */
  resyncing = false;

  constructor(private readonly limit = TERMINAL_STREAM_LIMIT) {}

  snapshot(): string {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join('')];
    return this.chunks[0] ?? '';
  }

  /** A view is showing this stream. */
  get watched(): boolean {
    return this.listeners.size > 0;
  }

  subscribe(listener: TerminalStreamListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Output without a `seq`: notices, or a backend without replay. */
  append(data: string) {
    if (!data) return;
    this.push(data);
    this.emit({ kind: 'data', data });
  }

  applyOutput(data: string, seq?: number): TerminalOutputResult {
    if (seq === undefined || !Number.isFinite(seq)) {
      this.append(data);
      return 'applied';
    }
    if (this.resyncing) return 'waiting';
    if (this.seq > 0 && seq <= this.seq) return 'duplicate';
    if (this.seq > 0 && seq > this.seq + 1) {
      this.resyncing = true;
      return 'gap';
    }
    this.seq = seq;
    this.append(data);
    return 'applied';
  }

  applyAttached({ reset, data, seq }: TerminalAttachedOutput) {
    this.resyncing = false;
    this.seq = seq;
    if (reset) {
      this.replace(data);
    } else {
      this.append(data);
    }
  }

  /** Empties the view and the kept output; `seq` numbering continues. */
  clear() {
    this.replace('');
  }

  /** Forgets the sequence, e.g. when a new process takes the terminal id. */
  restart() {
    this.seq = 0;
    this.resyncing = false;
  }

  private replace(data: string) {
    this.chunks = data ? [data] : [];
    this.length = data.length;
    this.trim();
    this.emit({ kind: 'reset', data });
  }

  private push(data: string) {
    this.chunks.push(data);
    this.length += data.length;
    this.trim();
  }

  /** Drops whole chunks from the front; a single oversized chunk keeps its tail. */
  private trim() {
    while (this.length > this.limit && this.chunks.length > 1) {
      this.length -= this.chunks.shift()!.length;
    }
    if (this.length > this.limit && this.chunks.length === 1) {
      const tail = this.chunks[0].slice(this.length - this.limit);
      this.chunks = [tail];
      this.length = tail.length;
    }
  }

  private emit(update: TerminalStreamUpdate) {
    for (const listener of this.listeners) listener(update);
  }
}

/** One stream per terminal id, created on first use. */
export class TerminalStreamStore {
  private streams = new Map<string, TerminalStream>();

  get(terminalId: string): TerminalStream {
    let stream = this.streams.get(terminalId);
    if (!stream) {
      stream = new TerminalStream();
      this.streams.set(terminalId, stream);
    }
    return stream;
  }

  peek(terminalId: string): TerminalStream | undefined {
    return this.streams.get(terminalId);
  }

  delete(terminalId: string) {
    this.streams.delete(terminalId);
  }

  /** Keeps only the listed terminals' output, and any a view still shows. */
  retain(terminalIds: Iterable<string>) {
    const keep = new Set(terminalIds);
    for (const [id, stream] of [...this.streams.entries()]) {
      if (!keep.has(id) && !stream.watched) this.streams.delete(id);
    }
  }
}
