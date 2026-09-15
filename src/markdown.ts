export type MarkdownBlock =
  | { type: 'h1' | 'h2' | 'h3' | 'bullet' | 'paragraph' | 'quote'; text: string }
  | { type: 'ordered'; text: string; ordinal: string }
  | { type: 'codeblock'; code: string; language?: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'rule' };

export type MarkdownInline = { type: 'text' | 'bold' | 'italic' | 'code' | 'link'; text: string; href?: string };

/** Incomplete streaming markup remains visible until its closing delimiter arrives. */
export function parseMarkdownInline(text: string): MarkdownInline[] {
  const result: MarkdownInline[] = [];
  const pattern = /(`+)([^`]*?)\1|\[([^\]]+)\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|https?:\/\/[^\s<>]+/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    if (start > cursor) result.push({ type: 'text', text: text.slice(cursor, start) });
    if (match[1]) result.push({ type: 'code', text: match[2] });
    else if (match[3]) result.push({ type: 'link', text: match[3], href: match[4].replace(/^<|>$/g, '') });
    else if (match[5] || match[6]) result.push({ type: 'bold', text: match[5] || match[6] });
    else if (match[7] || match[8]) result.push({ type: 'italic', text: match[7] || match[8] });
    else {
      const href = match[0].replace(/[.,;!?，。；！]+$/, '');
      result.push({ type: 'link', text: href, href });
      if (href.length < match[0].length) result.push({ type: 'text', text: match[0].slice(href.length) });
    }
    cursor = start + match[0].length;
  }
  if (cursor < text.length) result.push({ type: 'text', text: text.slice(cursor) });
  return result;
}

/** Split table cells without treating escaped/code-span pipes as delimiters. */
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let codeTicks = 0;
  const input = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '\\' && input[index + 1] === '|') { cell += '|'; index++; continue; }
    if (char === '`') {
      let count = 1;
      while (input[index + count] === '`') count++;
      if (codeTicks === count) codeTicks = 0;
      else if (!codeTicks) codeTicks = count;
      cell += '`'.repeat(count); index += count - 1; continue;
    }
    if (char === '|' && !codeTicks) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

export function parseMarkdownBlocks(raw: string): MarkdownBlock[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join('\n') }); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const fence = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      flush();
      const code: string[] = [];
      const closing = new RegExp(`^${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (++i < lines.length && !closing.test(lines[i].trim())) code.push(lines[i]);
      blocks.push({ type: 'codeblock', code: code.join('\n'), language: fence[2].trim() });
      continue;
    }
    if (!trimmed) { flush(); continue; }
    const header = tableCells(line);
    const separator = i + 1 < lines.length ? tableCells(lines[i + 1]) : [];
    if (line.includes('|') && header.length > 1 && separator.length === header.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
      flush(); i++;
      const rows: string[][] = [];
      while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].includes('|')) {
        const cells = tableCells(lines[++i]);
        rows.push(header.map((_, column) => cells[column] || ''));
      }
      blocks.push({ type: 'table', header, rows }); continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
    const bullet = trimmed.match(/^[-*•+]\s+(.*)$/);
    const ordered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (heading) { flush(); blocks.push({ type: `h${Math.min(3, heading[1].length)}` as 'h1' | 'h2' | 'h3', text: heading[2] }); }
    else if (/^(?:---+|___+|\*\*\*+)\s*$/.test(trimmed)) { flush(); blocks.push({ type: 'rule' }); }
    else if (bullet) { flush(); blocks.push({ type: 'bullet', text: bullet[1] }); }
    else if (ordered) { flush(); blocks.push({ type: 'ordered', ordinal: ordered[1], text: ordered[2] }); }
    else if (trimmed.startsWith('>')) { flush(); blocks.push({ type: 'quote', text: trimmed.replace(/^>\s?/, '') }); }
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
