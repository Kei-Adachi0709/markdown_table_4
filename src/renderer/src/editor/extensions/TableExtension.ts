import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { EditorState, RangeSetBuilder } from '@codemirror/state';

type Align = 'left' | 'center' | 'right' | null;

interface TableBlock {
  from: number; // table block range start in doc
  to: number;   // table block range end in doc (exclusive)
  headers: string[];
  aligns: Align[];
  rows: string[][];
  // true if original header/rows used outer pipes (not preserved strictly, but kept for future)
  hasOuterPipes: boolean;
}

function inCodeFenceTracker() {
  let fenced = false;
  return (line: string) => {
    // crude but effective code fence detection: lines starting with ```
    if (/^\s*```/.test(line)) fenced = !fenced;
    return fenced;
  };
}

function hasPipe(line: string) {
  // detect visible table-like line; ignore separator-only lines here
  return line.includes('|');
}

const delimiterRe = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function isDelimiterLine(line: string) {
  return delimiterRe.test(line.trim());
}

function splitRow(line: string): string[] {
  // Remove optional leading/trailing pipe but keep empty leading/trailing cells if present
  const trimmed = line.trim();
  let inner = trimmed;
  let hasLeading = false;
  let hasTrailing = false;
  if (inner.startsWith('|')) {
    hasLeading = true;
    inner = inner.slice(1);
  }
  if (inner.endsWith('|')) {
    hasTrailing = true;
    inner = inner.slice(0, -1);
  }

  const cells: string[] = [];
  let cur = '';
  let escaped = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (escaped) {
      cur += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());

  // If original had leading/trailing pipes, keep empty edge cells if the line reflected them
  if (hasLeading && inner.length === 0) {
    // a single '|' line -> one empty cell
    return [''];
  }
  return cells;
}

function parseAlignments(delimLine: string, expectedCols: number): Align[] {
  // Cells separated by '|', optional leading/trailing pipes supported
  const raw = splitRow(delimLine);
  const aligns: Align[] = raw.map(token => {
    const t = token.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  // Normalize to expected column count
  if (aligns.length < expectedCols) {
    while (aligns.length < expectedCols) aligns.push(null);
  } else if (aligns.length > expectedCols) {
    aligns.length = expectedCols;
  }
  return aligns;
}

function escapePipes(text: string) {
  return text.replace(/\|/g, '\\|');
}
function sanitizeCellForMarkdown(text: string) {
  // flatten newlines and trim surrounding spaces minimally
  return escapePipes(text.replace(/\r?\n/g, ' ').trim());
}

function serializeTable(block: TableBlock): string {
  const cols = Math.max(block.headers.length, ...block.rows.map(r => r.length));
  const headers = Array.from({ length: cols }, (_, i) => block.headers[i] ?? '');
  const aligns = Array.from({ length: cols }, (_, i) => block.aligns[i] ?? null);
  const rows = block.rows.map(r =>
    Array.from({ length: cols }, (_, i) => sanitizeCellForMarkdown(r[i] ?? ''))
  );

  const headerLine = `| ${headers.map(sanitizeCellForMarkdown).join(' | ')} |`;
  const delimLine = `| ${aligns
    .map(al => {
      switch (al) {
        case 'left':
          return ':---';
        case 'right':
          return '---:';
        case 'center':
          return ':---:';
        default:
          return '---';
      }
    })
    .join(' | ')} |`;
  const rowLines = rows.map(r => `| ${r.join(' | ')} |`);

  return [headerLine, delimLine, ...rowLines].join('\n');
}

function parseTablesInDoc(state: EditorState): TableBlock[] {
  const doc = state.doc;
  const blocks: TableBlock[] = [];
  const isFenced = inCodeFenceTracker();

  for (let ln = 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    const text = line.text;

    if (isFenced(text)) continue;

    if (!hasPipe(text)) continue;
    if (ln >= doc.lines) continue;

    const next = doc.line(ln + 1);
    if (!isDelimiterLine(next.text)) continue;

    // Collect rows
    let endLine = ln + 1;
    while (endLine + 1 <= doc.lines) {
      const candidate = doc.line(endLine + 1);
      const t = candidate.text.trim();
      if (t.length === 0) break;
      if (!hasPipe(candidate.text)) break;
      endLine++;
    }

    // Build block
    const headerCells = splitRow(text);
    const aligns = parseAlignments(next.text, headerCells.length);
    const rows: string[][] = [];
    for (let r = ln + 2; r <= endLine; r++) {
      const row = splitRow(doc.line(r).text);
      rows.push(row);
    }
    const from = line.from;
    const to = doc.line(endLine).to;

    blocks.push({
      from,
      to,
      headers: headerCells,
      aligns,
      rows,
      hasOuterPipes: /^\s*\|/.test(text.trim())
    });

    ln = endLine; // jump to end of this block
  }
  return blocks;
}

class TableWidget extends WidgetType {
  constructor(private viewRef: EditorView, private block: TableBlock) {
    super();
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof TableWidget)) return false;
    // Re-render when block content or range changed
    const a = this.block;
    const b = other.block;
    if (a.from !== b.from || a.to !== b.to) return false;
    if (a.headers.length !== b.headers.length) return false;
    if (a.rows.length !== b.rows.length) return false;
    for (let i = 0; i < a.headers.length; i++) if (a.headers[i] !== b.headers[i]) return false;
    for (let i = 0; i < a.rows.length; i++) {
      const ra = a.rows[i], rb = b.rows[i];
      if (ra.length !== rb.length) return false;
      for (let j = 0; j < ra.length; j++) if (ra[j] !== rb[j]) return false;
    }
    for (let i = 0; i < a.aligns.length; i++) if (a.aligns[i] !== b.aligns[i]) return false;
    return true;
  }

  ignoreEvent(): boolean {
    // Let the widget handle all events inside (so the editor doesn't hijack focus/selection)
    return true;
  }

  private dispatchReplace(updated: TableBlock) {
    const newText = serializeTable(updated);
    this.viewRef.dispatch({
      changes: { from: this.block.from, to: this.block.to, insert: newText }
    });
  }

  private buildCell(
    tag: 'th' | 'td',
    text: string,
    col: number,
    row: number | null,
    al: Align,
    updateValue: (val: string) => void
  ) {
    const el = document.createElement(tag);
    el.contentEditable = 'true';
    el.spellcheck = false;
    el.textContent = text;
    el.style.padding = '6px 8px';
    el.style.border = '1px solid #e5e7eb';
    el.style.minWidth = '48px';
    el.style.whiteSpace = 'pre-wrap';
    el.style.outline = 'none';
    el.dataset.col = String(col);
    if (row != null) el.dataset.row = String(row);
    if (tag === 'th') {
      el.style.background = '#f3f4f6';
      el.style.fontWeight = '600';
    }
    switch (al) {
      case 'left':
        el.style.textAlign = 'left';
        break;
      case 'center':
        el.style.textAlign = 'center';
        break;
      case 'right':
        el.style.textAlign = 'right';
        break;
    }

    const extractValue = () => (el.textContent ?? '').replace(/\r?\n/g, ' ');
    const commit = () => updateValue(extractValue());

    el.addEventListener('input', () => {
      // immediate sync
      commit();
    });
    el.addEventListener('blur', () => {
      commit();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
        (el as HTMLElement).blur();
      }
    });

    return el;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-md-table-widget';
    container.style.display = 'block';
    container.style.overflowX = 'auto';
    container.style.padding = '4px 0';

    const table = document.createElement('table');
    table.style.borderCollapse = 'collapse';
    table.style.fontFamily =
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Noto Sans, Ubuntu, Cantarell, Helvetica Neue, Arial';
    table.style.fontSize = '13.5px';
    table.style.color = '#111827';

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');

    const colCount = Math.max(this.block.headers.length, ...this.block.rows.map(r => r.length));
    const headers = Array.from({ length: colCount }, (_, i) => this.block.headers[i] ?? '');
    const aligns = Array.from({ length: colCount }, (_, i) => this.block.aligns[i] ?? null);

    headers.forEach((text, col) => {
      const th = this.buildCell('th', text, col, null, aligns[col] ?? null, (val) => {
        const updated: TableBlock = {
          ...this.block,
          headers: this.block.headers.map((h, i) => (i === col ? val : (this.block.headers[i] ?? ''))),
          aligns
        };
        // ensure headers array length
        if (updated.headers.length < colCount) {
          updated.headers = headers.map((_, i) => (i === col ? val : headers[i]));
        }
        this.dispatchReplace(updated);
      });
      trh.appendChild(th);
    });
    thead.appendChild(trh);

    const tbody = document.createElement('tbody');
    this.block.rows.forEach((row, rIdx) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        const td = this.buildCell('td', row[c] ?? '', c, rIdx, aligns[c] ?? null, (val) => {
          const newRows = this.block.rows.map((r, i) => (i === rIdx ? [...r] : r.slice()));
          if (!newRows[rIdx]) newRows[rIdx] = Array(colCount).fill('');
          newRows[rIdx][c] = val;
          const updated: TableBlock = {
            ...this.block,
            rows: newRows
          };
          this.dispatchReplace(updated);
        });
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    container.appendChild(table);
    return container;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const blocks = parseTablesInDoc(view.state);

  for (const block of blocks) {
    // Replace original markdown text
    builder.add(block.from, block.to, Decoration.replace({ block: true }));
    // Insert the widget at the start
    builder.add(
      block.from,
      block.from,
      Decoration.widget({
        widget: new TableWidget(view, block),
        block: true,
        side: 1
      })
    );
  }

  return builder.finish();
}

const tablePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

export const tableExtension = [tablePlugin] as const;