import {
  EditorView,
  ViewPlugin,
  ViewUpdate,
  Decoration,
  DecorationSet,
  WidgetType,
  keymap
} from '@codemirror/view';
import { EditorState, RangeSetBuilder, TransactionSpec } from '@codemirror/state';

type Align = 'left' | 'center' | 'right' | null;

interface TableBlock {
  from: number;
  to: number;
  headers: string[];
  aligns: Align[];
  rows: string[][];
  hasOuterPipes: boolean;
}

function inCodeFenceTracker() {
  let fenced = false;
  return (line: string) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    return fenced;
  };
}

function hasPipe(line: string) {
  return line.includes('|');
}

const delimiterRe = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
function isDelimiterLine(line: string) {
  return delimiterRe.test(line.trim());
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  let inner = trimmed;
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);

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
  return cells;
}

function parseAlignments(delimLine: string, expectedCols: number): Align[] {
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

    let endLine = ln + 1;
    while (endLine + 1 <= doc.lines) {
      const candidate = doc.line(endLine + 1);
      const t = candidate.text.trim();
      if (t.length === 0) break;
      if (!hasPipe(candidate.text)) break;
      endLine++;
    }

    const headerCells = splitRow(text);
    const aligns = parseAlignments(next.text, headerCells.length);
    const rows: string[][] = [];
    for (let r = ln + 2; r <= endLine; r++) rows.push(splitRow(doc.line(r).text));
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

    ln = endLine;
  }
  return blocks;
}

// ---- DOM Utils ----
function getTableWidgetContainer(el: Element | null): HTMLElement | null {
  let cur: Element | null = el;
  while (cur) {
    if (cur instanceof HTMLElement && cur.classList.contains('cm-md-table-widget')) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}
function getCellRC(el: Element): { row: number | null; col: number } | null {
  const cell = el.closest('td,th') as HTMLElement | null;
  if (!cell) return null;
  const col = cell.dataset.col ? parseInt(cell.dataset.col, 10) : NaN;
  const hasRow = cell.dataset.row != null;
  const row = hasRow ? parseInt(cell.dataset.row!, 10) : null;
  if (Number.isNaN(col)) return null;
  return { row, col };
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// ---- Widget ----
class TableWidget extends WidgetType {
  constructor(private viewRef: EditorView, private block: TableBlock) {
    super();
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof TableWidget)) return false;
    const a = this.block, b = other.block;
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

  ignoreEvent(event: Event): boolean {
    // key events should bubble to CM so keymap can run
    if (event.type === 'keydown' || event.type === 'keyup') return false;
    // prevent editor from interfering with mouse/selection inside widget
    return true;
  }

  private dispatchReplace(updated: TableBlock, after?: () => void) {
    const newText = serializeTable(updated);
    const tr: TransactionSpec = {
      changes: { from: this.block.from, to: this.block.to, insert: newText }
    };
    this.viewRef.dispatch(tr);
    if (after) setTimeout(after, 0);
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

    // 文字変更 → 即同期
    el.addEventListener('input', () => commit());
    el.addEventListener('blur', () => commit());

    // 選択開始・ドラッグ矩形
    el.addEventListener('mousedown', (e) => {
      const container = getTableWidgetContainer(el);
      if (!container) return;
      const rc0 = getCellRC(el);
      if (!rc0) return;

      const rowsCount = parseInt(container.dataset.rows || '0', 10);
      const colsCount = parseInt(container.dataset.cols || '0', 10);

      // anchor
      let aRow = rc0.row ?? 0; // ヘッダークリックは全列選択扱い→row=0起点
      let aCol = rc0.col;

      const clearSel = () => {
        container.querySelectorAll('td,th').forEach((c) => c.classList.remove('cm-cell-selected'));
      };
      const applySel = (r1: number, c1: number, r2: number, c2: number) => {
        clearSel();
        const rr1 = clamp(Math.min(r1, r2), 0, rowsCount - 1);
        const rr2 = clamp(Math.max(r1, r2), 0, rowsCount - 1);
        const cc1 = clamp(Math.min(c1, c2), 0, colsCount - 1);
        const cc2 = clamp(Math.max(c1, c2), 0, colsCount - 1);

        container.dataset.selR1 = String(rr1);
        container.dataset.selR2 = String(rr2);
        container.dataset.selC1 = String(cc1);
        container.dataset.selC2 = String(cc2);

        // header line
        const theadRow = container.querySelector('thead tr');
        if (theadRow) {
          for (let c = cc1; c <= cc2; c++) {
            const th = theadRow.children[c] as HTMLElement | undefined;
            if (th) th.classList.add('cm-cell-selected');
          }
        }
        // body
        const bodyRows = Array.from(container.querySelectorAll('tbody tr')) as HTMLElement[];
        for (let r = rr1; r <= rr2; r++) {
          const tr = bodyRows[r];
          if (!tr) continue;
          for (let c = cc1; c <= cc2; c++) {
            const td = tr.children[c] as HTMLElement | undefined;
            if (td) td.classList.add('cm-cell-selected');
          }
        }
      };

      // ヘッダーを基準に列選択
      if (rc0.row == null) {
        aRow = 0;
        applySel(0, aCol, rowsCount - 1, aCol);
      } else {
        applySel(aRow, aCol, aRow, aCol);
      }

      const onMove = (ev: MouseEvent) => {
        const el2 = ev.target instanceof Element ? ev.target : null;
        if (!el2) return;
        const rc2 = getCellRC(el2);
        if (!rc2) return;
        const hRow = rc2.row ?? (rc0.row == null ? rowsCount - 1 : rc0.row);
        const hCol = rc2.col;
        applySel(aRow, aCol, hRow, hCol);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // 右クリックメニュー
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const container = getTableWidgetContainer(el);
      if (!container) return;
      const rc = getCellRC(el);
      if (!rc) return;
      this.showContextMenu(container, rc, e.clientX, e.clientY);
    });

    return el;
  }

  private showContextMenu(container: HTMLElement, rc: { row: number | null; col: number }, x: number, y: number) {
    // 既存メニューを消す
    container.querySelectorAll('.cm-table-menu').forEach((m) => m.remove());

    const menu = document.createElement('div');
    menu.className = 'cm-table-menu';
    Object.assign(menu.style, {
      position: 'fixed',
      left: `${x}px`,
      top: `${y}px`,
      zIndex: '9999',
      background: '#111827',
      color: '#f9fafb',
      border: '1px solid #374151',
      borderRadius: '6px',
      fontSize: '13px',
      minWidth: '180px',
      boxShadow: '0 10px 25px rgba(0,0,0,0.25)'
    });

    const mkItem = (label: string, cb: () => void, enabled = true) => {
      const it = document.createElement('div');
      it.textContent = label;
      Object.assign(it.style, {
        padding: '8px 12px',
        cursor: enabled ? 'pointer' : 'not-allowed',
        opacity: enabled ? '1' : '0.5',
        userSelect: 'none'
      });
      it.addEventListener('mouseenter', () => (it.style.background = '#1f2937'));
      it.addEventListener('mouseleave', () => (it.style.background = 'transparent'));
      if (enabled) {
        it.addEventListener('click', () => {
          cb();
          menu.remove();
        });
      }
      return it;
    };

    const closeOnOutside = (ev: MouseEvent) => {
      if (!(ev.target instanceof Node) || !menu.contains(ev.target as Node)) {
        menu.remove();
        window.removeEventListener('mousedown', closeOnOutside, true);
      }
    };
    window.addEventListener('mousedown', closeOnOutside, true);

    const rowOpsEnabled = rc.row != null;
    const colOpsEnabled = true;

    // Row ops
    menu.appendChild(mkItem('上に行を挿入', () => this.insertRow(container, rc.col, rc.row!, 'above'), rowOpsEnabled));
    menu.appendChild(mkItem('下に行を挿入', () => this.insertRow(container, rc.col, rc.row!, 'below'), rowOpsEnabled));
    menu.appendChild(mkItem('行を削除', () => this.deleteRow(container, rc.row!), rowOpsEnabled));

    const sep = document.createElement('div');
    sep.style.height = '1px';
    sep.style.margin = '4px 0';
    sep.style.background = '#374151';
    menu.appendChild(sep);

    // Col ops
    menu.appendChild(mkItem('左に列を挿入', () => this.insertCol(container, rc.col, 'left'), colOpsEnabled));
    menu.appendChild(mkItem('右に列を挿入', () => this.insertCol(container, rc.col, 'right'), colOpsEnabled));
    menu.appendChild(mkItem('列を削除', () => this.deleteCol(container, rc.col), colOpsEnabled));

    document.body.appendChild(menu);
  }

  private focusCellAt(from: number, row: number | null, col: number) {
    try {
      const view = this.viewRef;
      const tryFocus = () => {
        // 同じ位置のウィジェットを探しセルにフォーカス
        const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`) as HTMLElement | null;
        if (!container) return;
        let target: HTMLElement | null = null;
        if (row == null || row < 0) {
          const th = container.querySelector(`thead tr > :nth-child(${col + 1})`) as HTMLElement | null;
          target = th;
        } else {
          const tr = container.querySelector(`tbody tr:nth-child(${row + 1})`) as HTMLElement | null;
          if (tr) target = tr.children[col] as HTMLElement | null;
        }
        target?.focus();
        // キャレット末尾へ
        if (target && target.firstChild instanceof Text) {
          const s = window.getSelection();
          const r = document.createRange();
          r.selectNodeContents(target);
          r.collapse(false);
          s?.removeAllRanges();
          s?.addRange(r);
        }
      };
      setTimeout(tryFocus, 0);
    } catch {
      // ignore
    }
  }

  private getBlockAtFrom(from: number): TableBlock | null {
    const blocks = parseTablesInDoc(this.viewRef.state);
    return blocks.find(b => b.from === from) ?? null;
  }

  // ---- Row/Col operations ----
  private insertRow(container: HTMLElement, col: number, row: number, where: 'above' | 'below') {
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(from) ?? this.block;
    const colCount = Math.max(block.headers.length, ...block.rows.map(r => r.length));
    const at = where === 'above' ? row : row + 1;
    const newRows = block.rows.slice();
    newRows.splice(at, 0, Array(colCount).fill(''));
    const updated: TableBlock = { ...block, rows: newRows };
    this.dispatchReplace(updated, () => this.focusCellAt(from, at, col));
  }

  private deleteRow(container: HTMLElement, row: number) {
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(from) ?? this.block;
    if (block.rows.length === 0) return;
    const newRows = block.rows.slice();
    const focusRow = Math.max(0, Math.min(row, newRows.length - 2));
    newRows.splice(row, 1);
    const updated: TableBlock = { ...block, rows: newRows };
    this.dispatchReplace(updated, () => this.focusCellAt(from, focusRow, 0));
  }

  private insertCol(container: HTMLElement, col: number, where: 'left' | 'right') {
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(from) ?? this.block;
    const at = where === 'left' ? col : col + 1;
    const headers = block.headers.slice();
    headers.splice(at, 0, '');
    const aligns = block.aligns.slice();
    aligns.splice(at, 0, null);
    const rows = block.rows.map(r => {
      const nr = r.slice();
      nr.splice(at, 0, '');
      return nr;
    });
    const updated: TableBlock = { ...block, headers, aligns, rows };
    this.dispatchReplace(updated, () => this.focusCellAt(from, 0, at));
  }

  private deleteCol(container: HTMLElement, col: number) {
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(from) ?? this.block;
    const headers = block.headers.slice();
    if (headers.length <= 1) return;
    headers.splice(col, 1);
    const aligns = block.aligns.slice();
    aligns.splice(col, 1);
    const rows = block.rows.map(r => {
      const nr = r.slice();
      if (nr.length > 0) nr.splice(col, 1);
      return nr;
    });
    const newCol = Math.max(0, Math.min(col, headers.length - 1));
    const updated: TableBlock = { ...block, headers, aligns, rows };
    this.dispatchReplace(updated, () => this.focusCellAt(from, 0, newCol));
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-md-table-widget';
    container.style.display = 'block';
    container.style.overflowX = 'auto';
    container.style.padding = '4px 0';
    container.dataset.from = String(this.block.from);

    const table = document.createElement('table');
    table.style.borderCollapse = 'collapse';
    table.style.fontFamily =
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Noto Sans, Ubuntu, Cantarell, Helvetica Neue, Arial';
    table.style.fontSize = '13.5px';
    table.style.color = '#111827';

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');

    const colCount = Math.max(this.block.headers.length, ...this.block.rows.map(r => r.length));
    container.dataset.rows = String(this.block.rows.length);
    container.dataset.cols = String(colCount);

    const headers = Array.from({ length: colCount }, (_, i) => this.block.headers[i] ?? '');
    const aligns = Array.from({ length: colCount }, (_, i) => this.block.aligns[i] ?? null);

    headers.forEach((text, col) => {
      const th = this.buildCell('th', text, col, null, aligns[col] ?? null, (val) => {
        const updated: TableBlock = {
          ...this.block,
          headers: headers.map((h, i) => (i === col ? val : h)),
          aligns
        };
        this.dispatchReplace(updated, () => this.focusCellAt(this.block.from, null, col));
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
          const updated: TableBlock = { ...this.block, rows: newRows };
          this.dispatchReplace(updated, () => this.focusCellAt(this.block.from, rIdx, c));
        });
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    // コピー時に参照しやすいようデータ属性保持
    container.dataset.rows = String(this.block.rows.length);
    container.dataset.cols = String(colCount);

    // クリック時、矩形選択のスタイルクラスを提供
    const styleSel = document.createElement('style');
    styleSel.textContent = `
      .cm-md-table-widget td.cm-cell-selected,
      .cm-md-table-widget th.cm-cell-selected {
        outline: 2px solid #22d3ee;
        outline-offset: -2px;
        background: #ecfeff;
      }
    `;
    container.appendChild(styleSel);

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
    builder.add(block.from, block.to, Decoration.replace({ block: true }));
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

// ---- キー操作（keymap） ----

function getActiveCellContext(view: EditorView) {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return null;
  const container = getTableWidgetContainer(el);
  if (!container) return null;
  const rc = getCellRC(el);
  if (!rc) return null;
  const from = parseInt(container.dataset.from || '-1', 10);
  if (Number.isNaN(from) || from < 0) return null;

  // 最新ブロックを取得
  const blocks = parseTablesInDoc(view.state);
  const block = blocks.find(b => b.from === from);
  if (!block) return null;

  const colCount = Math.max(block.headers.length, ...block.rows.map(r => r.length));
  const rowCount = block.rows.length;

  return {
    container,
    block,
    from,
    row: rc.row, // null=header
    col: rc.col,
    colCount,
    rowCount
  };
}

function focusCell(view: EditorView, from: number, row: number | null, col: number) {
  const tryFocus = () => {
    const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`) as HTMLElement | null;
    if (!container) return;
    let target: HTMLElement | null = null;
    if (row == null || row < 0) {
      target = container.querySelector(`thead tr > :nth-child(${col + 1})`) as HTMLElement | null;
    } else {
      const tr = container.querySelector(`tbody tr:nth-child(${row + 1})`) as HTMLElement | null;
      if (tr) target = tr.children[col] as HTMLElement | null;
    }
    target?.focus();
  };
  setTimeout(tryFocus, 0);
}

function cmdTab(view: EditorView): boolean {
  const ctx = getActiveCellContext(view);
  if (!ctx) return false;
  const { from, row, col, colCount, rowCount, block } = ctx;

  let nRow = row ?? 0;
  let nCol = col + 1;
  if (nCol >= colCount) {
    nCol = 0;
    nRow = (row ?? -1) + 1; // header -> first row
  }
  if (nRow >= rowCount) {
    // 最終行を越えた → 新規行を末尾に追加し、(rowCount, nCol)へ
    const newRow = Array(colCount).fill('');
    const updated: TableBlock = { ...block, rows: [...block.rows, newRow] };
    const newRowIndex = rowCount;
    const newText = serializeTable(updated);
    view.dispatch({ changes: { from: block.from, to: block.to, insert: newText } });
    focusCell(view, from, newRowIndex, nCol);
    return true;
  }
  focusCell(view, from, nRow, nCol);
  return true;
}

function cmdShiftTab(view: EditorView): boolean {
  const ctx = getActiveCellContext(view);
  if (!ctx) return false;
  const { from, row, col, colCount, rowCount } = ctx;

  let nRow = row ?? 0;
  let nCol = col - 1;
  if (nCol < 0) {
    nCol = colCount - 1;
    nRow = (row ?? 0) - 1;
  }
  if (nRow < 0) {
    // ヘッダーに移動
    focusCell(view, from, null, clamp(nCol, 0, colCount - 1));
    return true;
  }
  focusCell(view, from, clamp(nRow, 0, rowCount - 1), clamp(nCol, 0, colCount - 1));
  return true;
}

function cmdEnter(view: EditorView): boolean {
  const ctx = getActiveCellContext(view);
  if (!ctx) return false;
  const { from, row, col, rowCount, colCount, block } = ctx;
  let curRow = row ?? -1;
  let nRow = curRow + 1;
  if (nRow >= rowCount) {
    // 最終行 → 新しい行を追加してからフォーカス移動
    const newRow = Array(colCount).fill('');
    const updated: TableBlock = { ...block, rows: [...block.rows, newRow] };
    const newText = serializeTable(updated);
    view.dispatch({ changes: { from: block.from, to: block.to, insert: newText } });
    focusCell(view, from, rowCount, col);
    return true;
  } else {
    focusCell(view, from, nRow, col);
    return true;
  }
}

function moveHorizontal(view: EditorView, dir: -1 | 1): boolean {
  const ctx = getActiveCellContext(view);
  if (!ctx) return false;
  const { from, row, col, colCount, rowCount } = ctx;
  let nRow = row ?? 0;
  let nCol = col + dir;
  if (nCol < 0) {
    nCol = colCount - 1;
    nRow = (row ?? 0) - 1;
  } else if (nCol >= colCount) {
    nCol = 0;
    nRow = (row ?? -1) + 1;
  }
  if (nRow < 0) {
    focusCell(view, from, null, nCol);
    return true;
  }
  if (nRow >= rowCount) {
    // 下にはみ出ても、新規行は矢印では作らない（Enterのみが仕様）
    nRow = rowCount - 1;
  }
  focusCell(view, from, nRow, nCol);
  return true;
}

function moveVertical(view: EditorView, dir: -1 | 1): boolean {
  const ctx = getActiveCellContext(view);
  if (!ctx) return false;
  const { from, row, col, rowCount } = ctx;
  let nRow = (row ?? -1) + dir;
  if (nRow < 0) {
    // ヘッダーへ
    focusCell(view, from, null, col);
    return true;
  }
  if (nRow >= rowCount) {
    // 下にはみ出し → 最終行に留まる（Enterのみ追加）
    nRow = rowCount - 1;
  }
  focusCell(view, from, nRow, col);
  return true;
}

function copySelectionTSV(view: EditorView): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const container = getTableWidgetContainer(el);
  if (!container) return false;

  const r1 = container.dataset.selR1, r2 = container.dataset.selR2;
  const c1 = container.dataset.selC1, c2 = container.dataset.selC2;
  if (r1 == null || r2 == null || c1 == null || c2 == null) return false;

  const rr1 = parseInt(r1, 10), rr2 = parseInt(r2, 10);
  const cc1 = parseInt(c1, 10), cc2 = parseInt(c2, 10);

  const rows: string[] = [];
  const bodyRows = Array.from(container.querySelectorAll('tbody tr')) as HTMLElement[];
  for (let r = rr1; r <= rr2; r++) {
    const tr = bodyRows[r];
    if (!tr) continue;
    const cols: string[] = [];
    for (let c = cc1; c <= cc2; c++) {
      const td = tr.children[c] as HTMLElement | undefined;
      const text = td?.textContent ?? '';
      cols.push(text.replace(/\r?\n/g, ' '));
    }
    rows.push(cols.join('\t'));
  }
  const tsv = rows.join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tsv);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = tsv;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  };
  copy();
  return true;
}

export const tableKeymap = keymap.of([
  { key: 'Tab', run: cmdTab },
  { key: 'Shift-Tab', run: cmdShiftTab },
  { key: 'Enter', run: cmdEnter },
  { key: 'Mod-c', run: copySelectionTSV },

  { key: 'ArrowLeft', run: (v) => moveHorizontal(v, -1) },
  { key: 'ArrowRight', run: (v) => moveHorizontal(v, 1) },
  { key: 'ArrowUp', run: (v) => moveVertical(v, -1) },
  { key: 'ArrowDown', run: (v) => moveVertical(v, 1) }
]);

export const tableExtension = [tablePlugin] as const;