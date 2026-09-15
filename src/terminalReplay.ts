export type TerminalReplayEntry = { id: string; kind: string; text: string };

/** Local input is already echoed by the PTY, so never send it to xterm twice. */
export function terminalReplayDelta(output: readonly TerminalReplayEntry[], cursor: string) {
  const index = cursor ? output.findIndex(entry => entry.id === cursor) : -1;
  const reset = index < 0;
  const entries = index >= 0 ? output.slice(index + 1) : output;
  return {
    reset,
    data: entries.filter(entry => entry.kind === 'stdout' || entry.kind === 'stderr').map(entry => entry.text).join(''),
    cursor: output.at(-1)?.id || '',
  };
}
