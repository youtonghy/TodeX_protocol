export const TERMINAL_OUTPUT_CHARACTER_LIMIT = 512 * 1024;
export const GIT_DIFF_LINE_LIMIT = 10_000;
export const GIT_DIFF_CHARACTER_LIMIT = 1024 * 1024;

export type TerminalOutputRetention<Entry> = {
  entries: Entry[];
  truncated: boolean;
};

export function retainTerminalOutput<Entry extends { text: string }>(
  entries: readonly Entry[],
  entryLimit: number,
  characterLimit = TERMINAL_OUTPUT_CHARACTER_LIMIT,
): TerminalOutputRetention<Entry> {
  if (entries.length === 0) return { entries: [], truncated: false };

  const kept: Entry[] = [];
  let characterCount = 0;
  for (let index = entries.length - 1; index >= 0 && kept.length < entryLimit; index -= 1) {
    const entry = entries[index];
    if (kept.length > 0 && characterCount + entry.text.length > characterLimit) break;
    kept.push(entry);
    characterCount += entry.text.length;
  }
  kept.reverse();
  return {
    entries: kept,
    truncated: kept.length < entries.length,
  };
}

export type GitDiffLineKind = 'meta' | 'hunk' | 'addition' | 'deletion' | 'context';

export type GitDiffLine = {
  index: number;
  text: string;
  kind: GitDiffLineKind;
};

export type GitDiffViewModel = {
  lines: GitDiffLine[];
  additions: number;
  deletions: number;
  totalLines: number;
  truncated: boolean;
};

function classifyDiffLine(line: string): GitDiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'addition';
  if (line.startsWith('-')) return 'deletion';
  return 'context';
}

export function buildGitDiffViewModel(
  diff: string,
  lineLimit = GIT_DIFF_LINE_LIMIT,
  characterLimit = GIT_DIFF_CHARACTER_LIMIT,
): GitDiffViewModel {
  if (!diff) {
    return { lines: [], additions: 0, deletions: 0, totalLines: 0, truncated: false };
  }

  const lines: GitDiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let totalLines = 0;
  let displayedCharacters = 0;
  let start = 0;

  while (start <= diff.length) {
    const newline = diff.indexOf('\n', start);
    const end = newline === -1 ? diff.length : newline;
    const text = diff.slice(start, end);
    const kind = classifyDiffLine(text);
    if (kind === 'addition') additions += 1;
    if (kind === 'deletion') deletions += 1;

    const nextCharacterCount = displayedCharacters + text.length + (newline === -1 ? 0 : 1);
    if (lines.length < lineLimit && nextCharacterCount <= characterLimit) {
      lines.push({ index: totalLines, text, kind });
      displayedCharacters = nextCharacterCount;
    }
    totalLines += 1;
    if (newline === -1) break;
    start = newline + 1;
  }

  return {
    lines,
    additions,
    deletions,
    totalLines,
    truncated: lines.length < totalLines,
  };
}

