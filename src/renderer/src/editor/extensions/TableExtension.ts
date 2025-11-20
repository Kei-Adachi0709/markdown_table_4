import {
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
  keymap
} from '@codemirror/view';
import {
  EditorState,
  RangeSetBuilder,
  TransactionSpec,
  StateField,
  Prec,
  StateEffect
} from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

console.log('%c TableExtension Loaded (Fixed v3: Robust Focus & Layout) ', 'background: #222; color: #00ffff; font-weight: bold;');

const logPrefix = '[TableExt]';
function log(msg: string, ...args: any[]) {
  const DEBUG = true;
  if (DEBUG) console.log(`%c${logPrefix}`, 'color: #00d1b2; font-weight: bold;', msg, ...args);
}

type Align = 'left' | 'right' | 'center' | null;

interface TableBlock {
  from: number;
  to: number;
  headers: string[];
  aligns: Align[];
  rows: string[][];
}

type SelectionState = {
  type: 'col' | 'row' | 'rect' | 'none';
  anchor: { row: number | null; col: number } | null;
  head: { row: number | null; col: number } | null;
  selectedRows: Set<number>;
  selectedCols: Set<number>;
};

export const updateColWidthEffect = StateEffect.define<{ from: number; widths: number[] }>();

export const colWidthsField = StateField.define<{ [from: number]: number[] }>({
  create() { return {}; },
  update(value, tr) {
    const newMap: { [from: number]: number[] } = {};
    if (tr.docChanged) {
      for (const fromKey in value) {
        const oldFrom = Number(fromKey);
        const newFrom = tr.changes.mapPos(oldFrom, 1);
        if (newFrom !== null) newMap[newFrom] = value[oldFrom];
      }
    } else {
      Object.assign(newMap, value);
    }
    for (const effect of tr.effects) {
      if (effect.is(updateColWidthEffect)) {
        const { from, widths } = effect.value;
        newMap[from] = widths;
      }
    }
    return newMap;
  }
});

function getWidth(str: string): number {
  let width = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if ((c >= 0x00 && c < 0x81) || (c === 0xf8f0) || (c >= 0xff61 && c < 0xffa0) || (c >= 0xf8f1 && c < 0xf8f4)) {
      width += 1;
    } else {
      width += 2;
    }
  }
  return width;
}

function padRight(str: string, len: number): string {
  const w = getWidth(str);
  if (w >= len) return str;
  return str + ' '.repeat(len - w);
}

// ★ 修正: serializeTable で列数を保証してレイアウト崩れを防ぐ
function serializeTable(
  headers: string[], 
  aligns: Align[], 
  rows: string[][]
): string {
  const escape = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  
  if (headers.length === 0 && rows.length === 0) return '';

  // ヘッダーの長さを基準に列数を決定
  const colCount = headers.length;
  const colWidths = new Array(colCount).fill(0);

  headers.forEach((h, i) => {
    colWidths[i] = Math.max(colWidths[i], getWidth(escape(h)));
  });
  
  rows.forEach(row => {
    row.forEach((cell, i) => {
      if (i < colCount) {
        colWidths[i] = Math.max(colWidths[i], getWidth(escape(cell)));
      }
    });
  });

  for(let i=0; i<colCount; i++) {
    colWidths[i] = Math.max(colWidths[i], 3); 
  }

  const resultLines: string[] = [];

  const formatLine = (cells: string[]) => {
    return '| ' + cells.map((c, i) => padRight(c, colWidths[i])).join(' | ') + ' |';
  };

  // 1. Header
  resultLines.push(formatLine(headers.map(escape)));
  
  // 2. Delimiter (★ aligns が足りない場合は補完する)
  const safeAligns = Array.from({ length: colCount }, (_, i) => aligns[i] ?? null);
  
  const delimCells = safeAligns.map((a, i) => {
    const w = colWidths[i] || 3;
    if (a === 'left') return ':' + '-'.repeat(w - 1);
    if (a === 'right') return '-'.repeat(w - 1) + ':';
    if (a === 'center') return ':' + '-'.repeat(w - 2) + ':';
    return '-'.repeat(w);
  });
  resultLines.push('| ' + delimCells.join(' | ') + ' |');
  
  // 3. Rows
  rows.forEach(row => {
      const safeRow = Array.from({length: colCount}, (_, i) => row[i] ? escape(row[i]) : '');
      resultLines.push(formatLine(safeRow));
  });

  return resultLines.join('\n');
}

function parseTablesInDoc(state: EditorState): TableBlock[] {
  const blocks: TableBlock[] = [];
  const tree = syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Table') return;
      const from = node.from;
      const to = node.to;
      const headers: string[] = [];
      const aligns: Align[] = [];
      const rows: string[][] = [];
      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        const lineText = state.doc.sliceString(child.from, child.to); 
        if (child.name === 'TableHeader') {
          const parts = lineText.split('|').map(s => s.trim());
          if (parts.length > 0 && parts[0] === '') parts.shift();
          if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
          headers.push(...parts);
        } else if (child.name === 'TableDelim') {
          const parts = lineText.split('|').map(s => s.trim());
          if (parts.length > 0 && parts[0] === '') parts.shift();
          if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
          parts.forEach(p => {
            const left = p.startsWith(':');
            const right = p.endsWith(':');
            if (left && right) aligns.push('center');
            else if (left) aligns.push('left');
            else if (right) aligns.push('right');
            else aligns.push(null);
          });
        } else if (child.name === 'TableRow') {
          const parts = lineText.split('|').map(s => s.trim());
          if (parts.length > 0 && parts[0] === '') parts.shift();
          if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
          rows.push(parts);
        }
      }
      blocks.push({ from, to, headers, aligns, rows });
    }
  });
  return blocks;
}

function getTableWidgetContainer(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.closest<HTMLElement>('.cm-md-table-widget');
}

function getCellRC(el: HTMLElement | null): { row: number | null; col: number } | null {
  const cell = el?.closest('th, td') as HTMLTableCellElement | null;
  if (!cell) return null;
  const col = cell.cellIndex;
  const rowEl = cell.closest('tr');
  if (!rowEl) return null;
  const head = rowEl.closest('thead');
  if (head) return { row: null, col };
  const tbody = rowEl.closest('tbody');
  if (tbody) {
      const table = rowEl.closest('table');
      const theadRowCount = table?.tHead?.rows.length ?? 0;
      return { row: rowEl.rowIndex - theadRowCount, col }; 
  }
  return { row: rowEl.rowIndex, col };
}

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

class TableWidget extends WidgetType {
  private container: HTMLElement | null = null;
  private isOpeningContextMenu = false;
  private isProgrammaticFocus = false;
  private isDragging = false;
  private selection: SelectionState = {
      type: 'none',
      anchor: null,
      head: null,
      selectedRows: new Set(),
      selectedCols: new Set()
  };

  constructor(private block: TableBlock, private widths: number[] | null) {
    super();
  }

  eq(other: WidgetType): boolean {
    const o = other as TableWidget;
    if (
      o.block.from !== this.block.from ||
      o.block.to !== this.block.to ||
      o.block.headers.join('|') !== this.block.headers.join('|') ||
      o.block.rows.map(r => r.join('|')).join('||') !== this.block.rows.map(r => r.join('|')).join('||')
    ) return false;

    const w1 = this.widths ?? [];
    const w2 = o.widths ?? [];
    if (w1.length !== w2.length) return false;
    for (let i = 0; i < w1.length; i++) {
      if (w1[i] !== w2[i]) return false;
    }
    return true;
  }

  ignoreEvent(event: Event): boolean {
    // キーイベントは Widget 内で処理するために true を返す
    if (event.type === 'keydown') {
        const key = (event as KeyboardEvent).key;
        // 特殊キーは Widget 側でハンドリング
        if (['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'PageUp', 'PageDown', 'Home', 'End'].includes(key)) {
            return true;
        }
        // 修飾キーなしの単一文字入力も Widget (contentEditable) で処理
        if (key.length === 1 && !(event as KeyboardEvent).ctrlKey && !(event as KeyboardEvent).metaKey && !(event as KeyboardEvent).altKey) {
            return true;
        }
        return false; // コピーペーストなどは CodeMirror に任せる（場合による）
    }
    if (event.type === 'copy') return true;
    return true;
  }

  private dispatchReplace = (
    view: EditorView, 
    updated: TableBlock, 
    newWidths: number[] | null = null,
    after?: (latestFrom?: number) => void
  ) => {
    log('dispatchReplace: Scheduled.');
    setTimeout(() => {
      const initialFrom = this.block.from;
      const latestBlock = parseTablesInDoc(view.state).find(b => b.from === initialFrom);
      if (!latestBlock) {
          log('dispatchReplace: Block not found (deleted?). Aborting.');
          return;
      }
      
      const newText = serializeTable(updated.headers, updated.aligns, updated.rows);
      const trSpec: TransactionSpec = {
        changes: { from: latestBlock.from, to: latestBlock.to, insert: newText }
      };
      
      // 先にTransactionを適用して新しい座標を計算
      const tr = view.state.update(trSpec);
      view.dispatch(tr);
      
      const newFrom = tr.changes.mapPos(latestBlock.from, 1); 
      
      if (newWidths && newFrom !== null) {
           view.dispatch({
              effects: updateColWidthEffect.of({ from: newFrom, widths: newWidths })
          });
      }
      
      if (after) {
          // ★ 修正: DOM更新を確実に待つために requestAnimationFrame を使用
          requestAnimationFrame(() => {
             after(newFrom ?? latestBlock.from);
          });
      }
    }, 0); 
  }

  public focusCellAt = (view: EditorView, from: number, row: number | null, col: number) => {
    log(`focusCellAt: Trying to focus from=${from}, row=${row}, col=${col}`);
    
    // ★ 修正: リトライロジック付きのフォーカス処理
    const attemptFocus = (retryCount: number) => {
        // 古いコンテナではなく、最新の data-from を持つコンテナを探す
        const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`) as HTMLElement | null;
        
        if (!container) {
            if (retryCount > 0) {
                log(`focusCellAt: Container not found. Retrying... (${retryCount})`);
                // 少し待って再試行
                setTimeout(() => attemptFocus(retryCount - 1), 20);
            } else {
                log('focusCellAt: Container NOT found after retries. Giving up.');
            }
            return;
        }

        this.doFocus(container, row, col);
    };

    // 描画サイクルを待ってから開始
    requestAnimationFrame(() => attemptFocus(5)); // 5回までリトライ
  }

  private doFocus(container: HTMLElement, row: number | null, col: number) {
        let target: HTMLElement | null = null;
        if (row == null || row < 0) {
          target = container.querySelector(`thead tr > :nth-child(${col + 1})`) as HTMLElement | null;
        } else {
          const tr = container.querySelector(`tbody tr:nth-child(${row + 1})`) as HTMLElement | null;
          if (tr) target = tr.children[col] as HTMLElement | null;
        }

        if (target) {
          this.isProgrammaticFocus = true;
          target.focus();
          
          // カーソルを末尾に
          if (target.firstChild instanceof Text) {
            const s = window.getSelection();
            const r = document.createRange();
            r.selectNodeContents(target);
            r.collapse(false);
            s?.removeAllRanges();
            s?.addRange(r);
          }
          log('focusCellAt: Focused successfully!');
        } else {
            log('focusCellAt: Target cell element not found in container.');
        }
  }

  private getBlockAtFrom = (state: EditorState, from: number): TableBlock | null => {
    const blocks = parseTablesInDoc(state);
    return blocks.find(b => b.from === from) ?? null;
  }

  // ---- Selection Logic ----
  private clearSelection() {
    if (this.selection.type !== 'none') {
      this.selection = {
          type: 'none',
          anchor: null,
          head: null,
          selectedRows: new Set(),
          selectedCols: new Set()
      };
      this.updateSelectionStyles();
    }
  }

  private updateSelectionRange() {
      if (!this.selection.anchor || !this.selection.head) return;
      const r1 = this.selection.anchor.row; 
      const c1 = this.selection.anchor.col;
      const r2 = this.selection.head.row;
      const c2 = this.selection.head.col;
      const rStart = (r1 === null ? -1 : r1);
      const rEnd = (r2 === null ? -1 : r2);
      const minR = Math.min(rStart, rEnd);
      const maxR = Math.max(rStart, rEnd);
      const minC = Math.min(c1, c2);
      const maxC = Math.max(c1, c2);

      this.selection.selectedRows.clear();
      this.selection.selectedCols.clear();

      if (this.selection.type === 'rect') {
          for (let r = minR; r <= maxR; r++) this.selection.selectedRows.add(r);
          for (let c = minC; c <= maxC; c++) this.selection.selectedCols.add(c);
      } 
      else if (this.selection.type === 'row') {
          const colCount = Math.max(this.block.headers.length, ...this.block.rows.map(r => r.length));
          for (let c = 0; c < colCount; c++) this.selection.selectedCols.add(c);
          for (let r = minR; r <= maxR; r++) this.selection.selectedRows.add(r);
      }
      else if (this.selection.type === 'col') {
          const rowCount = this.block.rows.length;
          this.selection.selectedRows.add(-1); 
          for (let r = 0; r < rowCount; r++) this.selection.selectedRows.add(r);
          for (let c = minC; c <= maxC; c++) this.selection.selectedCols.add(c);
      }
      this.updateSelectionStyles();
  }

  private updateSelectionStyles() {
    if (!this.container) return;
    const table = this.container.querySelector('table');
    if (!table) return;
    const rows = Array.from(table.rows); 
    const theadRowCount = table.tHead?.rows.length ?? 0;
    rows.forEach((tr) => {
      const isHeader = tr.parentElement?.tagName === 'THEAD';
      const bodyRowIndex = isHeader ? -1 : tr.rowIndex - theadRowCount;
      Array.from(tr.cells).forEach((cell, cIdx) => {
        let selected = false;
        if (this.selection.type === 'rect') {
            if (this.selection.selectedRows.has(bodyRowIndex) && this.selection.selectedCols.has(cIdx)) selected = true;
        } else {
            if (this.selection.selectedRows.has(bodyRowIndex) && this.selection.selectedCols.has(cIdx)) selected = true;
        }
        if (selected) {
            cell.classList.add('cm-table-selected');
        } else {
            cell.classList.remove('cm-table-selected');
        }
      });
    });
  }

  private startSelection(rc: { row: number | null; col: number }, type: 'col' | 'row' | 'rect') {
      this.selection.type = type;
      this.selection.anchor = rc;
      this.selection.head = rc;
      this.isDragging = true;
      this.updateSelectionRange();
  }

  private updateDrag(rc: { row: number | null; col: number }) {
      if (!this.isDragging || this.selection.type === 'none') return;
      if (this.selection.head?.row !== rc.row || this.selection.head?.col !== rc.col) {
          this.selection.head = rc;
          this.updateSelectionRange();
      }
  }

  private getMouseAction(e: MouseEvent): { type: 'col' | 'row' | 'cell' | null; index: number; rc: {row: number|null, col: number} | null } {
    const target = e.target as HTMLElement;
    const targetCell = target.closest('th, td') as HTMLElement | null;
    if (!targetCell) return { type: null, index: -1, rc: null };
    const rect = targetCell.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const rc = getCellRC(targetCell);
    if (!rc) return { type: null, index: -1, rc: null };

    if (e.ctrlKey || e.metaKey) {
        if (targetCell.tagName === 'TH') return { type: 'col', index: rc.col, rc };
        if (rc.row !== null) return { type: 'row', index: rc.row, rc };
    }
    
    const isHeader = targetCell.tagName === 'TH';
    const isFirstCol = rc.col === 0;
    const COL_SELECT_EDGE = isHeader ? 20 : 10; 
    const ROW_SELECT_EDGE = isFirstCol ? 20 : 10;
    const RESIZER_WIDTH = 8;

    if (offsetX > rect.width - RESIZER_WIDTH) {
        return { type: null, index: -1, rc: null };
    }
    if (offsetY < COL_SELECT_EDGE) {
        return { type: 'col', index: rc.col, rc };
    }
    if (offsetX < ROW_SELECT_EDGE) {
        if (rc.row !== null) {
            return { type: 'row', index: rc.row, rc };
        }
    }
    return { type: 'cell', index: -1, rc };
  }

  private handleMouseMove = (e: MouseEvent) => {
    if (document.body.classList.contains('cm-table-resizing')) return;
    if (this.isDragging) {
        const target = e.target as HTMLElement;
        const targetCell = target.closest('th, td') as HTMLElement | null;
        if (targetCell) {
            const rc = getCellRC(targetCell);
            if (rc) {
                this.updateDrag(rc);
                e.preventDefault();
            }
        }
        return;
    }
    const target = e.target as HTMLElement;
    const targetCell = target.closest('th, td') as HTMLElement | null;
    if (this.container) this.container.style.cursor = 'default';
    if (targetCell) targetCell.style.cursor = 'text';
    const action = this.getMouseAction(e);
    if (action.type === 'col' && targetCell) targetCell.style.cursor = 's-resize'; 
    else if (action.type === 'row' && targetCell) targetCell.style.cursor = 'e-resize';
  }

  private handleMouseDown = (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains('cm-table-resizer')) return;
    if (e.button !== 0) return;

    const action = this.getMouseAction(e);
    const onMouseUp = () => {
        this.isDragging = false;
        window.removeEventListener('mouseup', onMouseUp);
        this.container?.focus({ preventScroll: true });
    };
    window.addEventListener('mouseup', onMouseUp);

    if (action.type === 'col' && action.rc) {
        this.startSelection(action.rc, 'col');
        e.preventDefault();
        e.stopPropagation();
        this.container?.focus({ preventScroll: true });
    } else if (action.type === 'row' && action.rc) {
        this.startSelection(action.rc, 'row');
        e.preventDefault();
        e.stopPropagation();
        this.container?.focus({ preventScroll: true });
    } else if (action.type === 'cell' && action.rc) {
        this.startSelection(action.rc, 'rect');
    } else {
        this.clearSelection();
    }
  }

  private performCopy = (view: EditorView) => {
      if (this.selection.type === 'none' || this.selection.selectedRows.size === 0) return;
      const currentBlock = this.getBlockAtFrom(view.state, this.block.from);
      if (!currentBlock) return;

      const targetRows = Array.from(this.selection.selectedRows).sort((a, b) => a - b);
      const targetCols = Array.from(this.selection.selectedCols).sort((a, b) => a - b);

      const safeHeaders = currentBlock.headers || [];
      const safeAligns = currentBlock.aligns || [];
      const safeRows = currentBlock.rows || [];

      const hasOriginalHeader = targetRows.includes(-1);
      const dataRowsIndices = targetRows.filter(r => r >= 0);
      
      const extractCols = (row: string[]) => targetCols.map(c => row && row[c] ? row[c] : '');

      const newAligns = targetCols.map(c => safeAligns[c] ?? null);

      let newRows = dataRowsIndices.map(r => extractCols(safeRows[r]));
      let newHeaders: string[] = [];

      if (hasOriginalHeader) {
          newHeaders = extractCols(safeHeaders);
      } else {
          newHeaders = targetCols.map(() => '');
      }

      let markdownTable = serializeTable(newHeaders, newAligns, newRows);
      markdownTable = '\n' + markdownTable + '\n';

      log('performCopy: Copied to clipboard');
      navigator.clipboard.writeText(markdownTable).catch(err => {
          console.error('performCopy: Failed to write to clipboard', err);
      });
  }

  private handleCopyEvent = (e: ClipboardEvent, view: EditorView) => {
      if (this.selection.type === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      this.performCopy(view);
  }

  private handleKeyDown = (e: KeyboardEvent, view: EditorView) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
          if (this.selection.type !== 'none') {
              e.preventDefault();
              e.stopPropagation();
              this.performCopy(view);
          }
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab'].includes(e.key)) {
          this.clearSelection();
      }
  }

  toDOM(view: EditorView): HTMLElement {
    log('toDOM called');
    const container = document.createElement('div');
    this.container = container; 
    container.className = 'cm-md-table-widget';
    container.style.padding = '4px';
    container.style.border = '1px dashed #ddd';
    container.style.borderRadius = '4px';
    container.style.margin = '1em 0';
    container.style.overflowX = 'auto';
    container.style.minHeight = '20px';
    container.tabIndex = -1; 
    container.style.outline = 'none'; 
    
    container.addEventListener('mousemove', this.handleMouseMove);
    container.addEventListener('mousedown', this.handleMouseDown); 
    container.addEventListener('copy', (e) => this.handleCopyEvent(e, view));
    container.addEventListener('keydown', (e) => this.handleKeyDown(e, view));

    container.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        log('contextmenu triggered');
        const action = this.getMouseAction(e); 
        if (action.rc) {
            this.showContextMenu(view, container, action.rc, e.clientX, e.clientY);
        }
    });

    const table = document.createElement('table');
    table.style.borderCollapse = 'collapse';
    table.style.tableLayout = this.widths ? 'fixed' : 'auto';
    table.style.width = this.widths ? 'auto' : '100%';
    table.style.minWidth = '100px';

    const colCount = Math.max(
      this.block.headers.length,
      this.block.aligns.length,
      ...this.block.rows.map(r => r.length)
    );
    container.dataset.from = this.block.from.toString();
    container.dataset.colCount = colCount.toString();
    container.dataset.rowCount = this.block.rows.length.toString();
    const colgroup = document.createElement('colgroup');
    for (let i = 0; i < colCount; i++) {
        const colEl = document.createElement('col');
        if (this.widths && this.widths[i]) colEl.style.width = `${this.widths[i]}px`;
        colgroup.appendChild(colEl);
    }
    table.appendChild(colgroup);
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    trh.style.backgroundColor = '#f8f8f8';
    const headers = Array.from({ length: colCount }, (_, i) => this.block.headers[i] ?? '');
    const aligns = Array.from({ length: colCount }, (_, i) => this.block.aligns[i] ?? null);
    headers.forEach((text, col) => {
      const th = this.buildCell('th', text, col, null, aligns[col] ?? null, (val, after) => {
        const currentBlock = this.getBlockAtFrom(view.state, this.block.from) ?? this.block;
        const newHeaders = headers.map((h, i) => (i === col ? val : h));
        const newAligns = aligns.slice();
        while(newAligns.length < newHeaders.length) newAligns.push(null);
        const updated: TableBlock = { ...currentBlock, headers: newHeaders, aligns: newAligns };
        this.dispatchReplace(view, updated, null, (latestFrom) => {
            if (after) after(latestFrom ?? this.block.from);
            else this.focusCellAt(view, latestFrom ?? this.block.from, null, col);
        });
      }, view);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    const tbody = document.createElement('tbody');
    this.block.rows.forEach((row, rIdx) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        const td = this.buildCell('td', row[c] ?? '', c, rIdx, aligns[c] ?? null, (val, after) => {
          const currentBlock = this.getBlockAtFrom(view.state, this.block.from) ?? this.block;
          const newRows = currentBlock.rows.map((r, i) => (i === rIdx ? [...r] : r.slice()));
          if (!newRows[rIdx]) newRows[rIdx] = Array(colCount).fill('');
          while(newRows[rIdx].length < colCount) newRows[rIdx].push('');
          newRows[rIdx][c] = val;
          const updated: TableBlock = { ...currentBlock, rows: newRows };
          this.dispatchReplace(view, updated, null, (latestFrom) => {
            if (after) after(latestFrom ?? this.block.from);
            else this.focusCellAt(view, latestFrom ?? this.block.from, rIdx, c);
          });
        }, view);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    container.appendChild(table);
    setTimeout(() => this.updateSelectionStyles(), 0);
    return container;
  }

  private createResizer(view: EditorView, th: HTMLTableCellElement, colIndex: number) {
      const resizer = document.createElement('div');
      resizer.className = 'cm-table-resizer';
      resizer.addEventListener('mousedown', (e: MouseEvent) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          if (!this.container) return;
          const table = this.container.querySelector('table');
          if (!table) return;
          const colgroup = table.querySelector('colgroup');
          if (!colgroup) return;
          const cols = Array.from(colgroup.children) as HTMLTableColElement[];
          const currentWidths = cols.map(c => c.offsetWidth);
          for (let i = 0; i < cols.length; i++) cols[i].style.width = `${currentWidths[i]}px`;
          const startX = e.clientX;
          const startWidth = currentWidths[colIndex]; 
          table.style.tableLayout = 'fixed';
          table.style.width = 'auto';
          document.body.classList.add('cm-table-resizing'); 
          const onMouseMove = (e: MouseEvent) => {
              const deltaX = e.clientX - startX;
              const newWidth = Math.max(50, startWidth + deltaX);
              cols[colIndex].style.width = `${newWidth}px`;
          };
          const onMouseUp = () => {
              window.removeEventListener('mousemove', onMouseMove);
              window.removeEventListener('mouseup', onMouseUp);
              document.body.classList.remove('cm-table-resizing');
              const finalWidths = cols.map(c => c.offsetWidth);
              const latestFrom = (this.getBlockAtFrom(view.state, this.block.from) ?? this.block).from;
              view.dispatch({
                  effects: updateColWidthEffect.of({ from: latestFrom, widths: finalWidths })
              });
          };
          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
      });
      return resizer;
  }

  private buildCell = (
    tag: 'th' | 'td',
    text: string,
    col: number,
    row: number | null,
    al: Align,
    updateValue: (val: string, after?: (from: number) => void) => void,
    view: EditorView
  ) => {
    const el = document.createElement(tag);
    el.contentEditable = 'true';
    el.textContent = text;
    el.style.minWidth = '50px';
    el.style.textAlign = al ?? 'left';
    el.style.padding = '4px 8px';
    el.style.border = '1px solid #ccc';
    el.style.backgroundColor = tag === 'th' ? '#f0f0f0' : '#ffffff';
    el.style.position = 'relative';
    el.style.outline = 'none';
    if (tag === 'th') {
        const resizer = this.createResizer(view, el, col);
        el.appendChild(resizer);
    }
    el.addEventListener('focus', () => {
      el.style.boxShadow = 'inset 0 0 0 2px #007bff';
      this.isProgrammaticFocus = false;
    });
    const extractValue = () => (el.textContent ?? '').replace(/\r?\n/g, ' ');
    const commit = (after?: (from: number) => void) => {
      const latestBlock = this.getBlockAtFrom(view.state, this.block.from);
      if (!latestBlock) return;
      const currentValue = (tag === 'th' ? latestBlock.headers[col] : (latestBlock.rows[row!]?.[col] ?? ''));
      const newValue = extractValue();
      if (currentValue === newValue) {
          log('commit: no change');
          if (after) after(latestBlock.from);
          return;
      }
      log(`commit: value changed to "${newValue}"`);
      updateValue(newValue, after);
    }
    el.addEventListener('blur', (e: FocusEvent) => {
      el.style.boxShadow = 'none';
      if (this.isProgrammaticFocus) return; 
      if (this.isOpeningContextMenu) {
        this.isOpeningContextMenu = false; 
        return; 
      }
      const relatedTarget = e.relatedTarget as HTMLElement | null;
      const container = this.container; 
      if (container && relatedTarget && container.contains(relatedTarget)) return; 
      if (!el.isConnected) return; 
      commit(); 
    });
    el.addEventListener('keydown', (e) => {
      if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
          e.preventDefault();
          log(`keydown: ${e.key} - Custom handling`);
          if (e.key === 'PageUp') moveVerticalPage('up')(view);
          if (e.key === 'PageDown') moveVerticalPage('down')(view);
          if (e.key === 'Home') moveHorizontalPage('home')(view);
          if (e.key === 'End') moveHorizontalPage('end')(view);
          this.clearSelection();
          return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        log('keydown: Enter');
        const container = getTableWidgetContainer(el);
        if (!container) return;
        const from = parseInt(container.dataset.from!, 10);
        const rowCount = parseInt(container.dataset.rowCount!, 10);
        const rc = getCellRC(el);
        if (!rc || rc.row == null) return;
        const currentRow = rc.row;
        const currentCol = rc.col;
        
        commit((latestFrom) => {
             if (currentRow < rowCount - 1) {
                 log('Enter: Moving to next row');
                 this.focusCellAt(view, latestFrom, currentRow + 1, currentCol);
             } else {
                 log('Enter: Adding new row at end');
                 const block = this.getBlockAtFrom(view.state, latestFrom);
                 if (!block) return;
                 const currentCols = Math.max(block.headers.length, ...block.rows.map(r => r.length));
                 const newRow = Array(currentCols).fill('');
                 const updated: TableBlock = { ...block, rows: [...block.rows, newRow] };
                 
                 this.dispatchReplace(view, updated, null, (finalFrom) => {
                     this.focusCellAt(view, finalFrom ?? latestFrom, rowCount, currentCol);
                 });
             }
        });
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab'].includes(e.key)) {
          this.clearSelection();
      }
    });
    return el;
  }
  private showContextMenu = (view: EditorView, container: HTMLElement, rc: { row: number | null; col: number }, x: number, y: number) => {
    container.querySelectorAll('.cm-table-menu').forEach((m) => m.remove());
    const menu = document.createElement('div');
    menu.className = 'cm-table-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.backgroundColor = 'white';
    menu.style.border = '1px solid #ccc';
    menu.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
    menu.style.zIndex = '1000';
    menu.style.padding = '4px 0';
    menu.style.fontFamily = 'sans-serif';
    menu.style.fontSize = '14px';
    menu.style.minWidth = '120px';
    const mkItem = (label: string, cb: () => void, enabled = true) => {
      const it = document.createElement('div');
      it.style.padding = '4px 12px';
      it.style.cursor = enabled ? 'pointer' : 'default';
      it.style.color = enabled ? '#333' : '#aaa';
      it.textContent = label;
      if (enabled) {
        it.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          cb();
          menu.remove();
        });
        it.addEventListener('mouseenter', () => (it.style.backgroundColor = '#f0f0f0'));
        it.addEventListener('mouseleave', () => (it.style.backgroundColor = 'white'));
      }
      return it;
    };
    const closeOnOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener('click', closeOnOutside);
      }
    };
    setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
    const rowOpsEnabled = rc.row != null;
    const colOpsEnabled = true;
    menu.appendChild(mkItem('上に行を挿入', () => this.insertRow(view, container, rc.col, rc.row!, 'above'), rowOpsEnabled));
    menu.appendChild(mkItem('下に行を挿入', () => this.insertRow(view, container, rc.col, rc.row!, 'below'), rowOpsEnabled));
    menu.appendChild(mkItem('行を削除', () => this.deleteRow(view, container, rc.row!), rowOpsEnabled));
    const sep = document.createElement('div');
    sep.style.height = '1px';
    sep.style.backgroundColor = '#eee';
    sep.style.margin = '4px 0';
    menu.appendChild(sep);
    menu.appendChild(mkItem('左に列を挿入', () => this.insertCol(view, container, rc.col, rc.row, 'left'), colOpsEnabled));
    menu.appendChild(mkItem('右に列を挿入', () => this.insertCol(view, container, rc.col, rc.row, 'right'), colOpsEnabled));
    menu.appendChild(mkItem('列を削除', () => this.deleteCol(view, container, rc.col), colOpsEnabled));
    document.body.appendChild(menu);
  }
  private insertRow = (view: EditorView, container: HTMLElement, col: number, row: number, where: 'above' | 'below') => {
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
    const colCount = Math.max(block.headers.length, ...block.rows.map(r => r.length));
    const at = where === 'above' ? row : row + 1;
    const newRows = block.rows.slice();
    newRows.splice(at, 0, Array(colCount).fill(''));
    const updated: TableBlock = { ...block, rows: newRows };
    this.dispatchReplace(view, updated, null, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, at, col));
  }
  private deleteRow = (view: EditorView, container: HTMLElement, row: number) => {
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
    if (block.rows.length === 0) return;
    const newRows = block.rows.slice();
    const focusRow = Math.max(0, Math.min(row, newRows.length - 2));
    newRows.splice(row, 1);
    const updated: TableBlock = { ...block, rows: newRows };
    this.dispatchReplace(view, updated, null, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, focusRow, 0));
  }
  private insertCol = (view: EditorView, container: HTMLElement, col: number, row: number | null, where: 'left' | 'right') => {
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
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
    const currentWidths = (view.state.field(colWidthsField) ?? {})[from];
    let newWidths: number[] | null = null;
    if (currentWidths) {
        newWidths = currentWidths.slice();
        newWidths.splice(at, 0, 100); 
    }
    this.dispatchReplace(view, updated, newWidths, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, row, at));
  }
  private deleteCol = (view: EditorView, container: HTMLElement, col: number) => {
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
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
    const currentWidths = (view.state.field(colWidthsField) ?? {})[from];
    let newWidths: number[] | null = null;
    if (currentWidths) {
        newWidths = currentWidths.slice();
        newWidths.splice(col, 1); 
    }
    this.dispatchReplace(view, updated, newWidths, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, 0, newCol));
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const blocks = parseTablesInDoc(state); 
  const widthsMap = state.field(colWidthsField);
  for (const block of blocks) {
    const widths = widthsMap[block.from] ?? null;
    builder.add(
      block.from,
      block.to,
      Decoration.replace({
        widget: new TableWidget(block, widths)
      })
    );
  }
  return builder.finish();
}

export const tableDecoField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, tr) {
    const needsUpdate = tr.docChanged || tr.effects.some(e => e.is(updateColWidthEffect));
    if (!needsUpdate) return value;
    return buildDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f)
});

// Keymap helpers...
function getActiveCellContext(view: EditorView) {
  const focused = view.hasFocus ? document.activeElement : null;
  if (!focused || (focused.tagName !== 'TH' && focused.tagName !== 'TD')) return null;
  const container = getTableWidgetContainer(focused as HTMLElement);
  if (!container) return null;
  const rc = getCellRC(focused as HTMLElement);
  if (!rc) return null;
  const from = parseInt(container.dataset.from!, 10);
  const colCount = parseInt(container.dataset.colCount!, 10);
  const rowCount = parseInt(container.dataset.rowCount!, 10);
  const block = parseTablesInDoc(view.state).find(b => b.from === from) ?? null;
  if (!block) return null;
  return { ...rc, from, colCount, rowCount, block, el: focused as HTMLElement };
}
function focusCell(view: EditorView, from: number, row: number | null, col: number) {
  const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`) as HTMLElement | null;
  if (!container) return;
  let target: HTMLElement | null = null;
  if (row == null || row < 0) {
    target = container.querySelector(`thead tr > :nth-child(${col + 1})`) as HTMLElement | null;
  } else {
    const tr = container.querySelector(`tbody tr:nth-child(${row + 1})`) as HTMLElement | null;
    if (tr) target = tr.children[col] as HTMLElement | null;
  }
  if (target) {
    setTimeout(() => {
        target?.focus();
        try {
          if (target && target.firstChild instanceof Text) {
            const s = window.getSelection();
            const r = document.createRange();
            r.selectNodeContents(target);
            r.collapse(false);
            s?.removeAllRanges();
            s?.addRange(r);
          }
        } catch { /* noop */ }
    }, 0);
  }
}
function cmdTab(view: EditorView): boolean {
  const ctx = getActiveCellContext(view);
  if (!ctx) return false;
  const { from, row, col, rowCount, colCount } = ctx;
  let nRow = row ?? -1;
  let nCol = col + 1;
  if (nCol >= colCount) {
    nCol = 0;
    nRow += 1;
  }
  if (nRow >= rowCount) return false; 
  focusCell(view, from, nRow < 0 ? null : nRow, nCol);
  return true;
}
function cmdShiftTab(view: EditorView): boolean {
  const ctx = getActiveCellContext(view);
  if (!ctx) return false;
  const { from, row, col, colCount } = ctx;
  let nRow = row ?? -1;
  let nCol = col - 1;
  if (nCol < 0) {
    nCol = colCount - 1;
    nRow -= 1;
  }
  if (nRow < -1) return false;
  focusCell(view, from, nRow < 0 ? null : nRow, nCol);
  return true;
}
function moveHorizontal(dir: 'left' | 'right') {
  return (view: EditorView): boolean => {
    const ctx = getActiveCellContext(view);
    if (!ctx) return false;
    const { from, row, col, colCount } = ctx;
    const nCol = clamp(col + (dir === 'left' ? -1 : 1), 0, colCount - 1);
    if (nCol === col) return false;
    focusCell(view, from, row, nCol);
    return true;
  };
}
function moveVertical(dir: 'up' | 'down') {
  return (view: EditorView): boolean => {
    const ctx = getActiveCellContext(view);
    if (!ctx) return false;
    const { from, row, col, rowCount } = ctx;
    let nRow: number | null = row ?? -1; 
    if (dir === 'up') {
      if (nRow === 0) nRow = null; 
      else if (nRow > 0) nRow = nRow - 1; 
      else return false; 
    } else {
      if (nRow === null) nRow = 0; 
      else if (nRow < rowCount - 1) nRow = nRow + 1; 
      else return false; 
    }
    focusCell(view, from, nRow, col);
    return true;
  };
}
function moveVerticalPage(dir: 'up' | 'down') {
    return (view: EditorView): boolean => {
        const ctx = getActiveCellContext(view);
        if (!ctx) return false;
        const { from, col, row, rowCount } = ctx;
        let nRow: number | null;
        if (dir === 'up') {
            if (row === null) return true; 
            nRow = null; 
        } else {
            if (row === rowCount - 1) return true; 
            nRow = rowCount - 1; 
        }
        focusCell(view, from, nRow, col);
        return true;
    };
}
function moveHorizontalPage(dir: 'home' | 'end') {
    return (view: EditorView): boolean => {
        const ctx = getActiveCellContext(view);
        if (!ctx) return false;
        const { from, row, col, colCount } = ctx;
        let nCol: number;
        if (dir === 'home') {
            if (col === 0) return true; 
            nCol = 0; 
        } else {
            if (col === colCount - 1) return true; 
            nCol = colCount - 1; 
        }
        focusCell(view, from, row, nCol);
        return true;
    };
}
function copySelectionTSV(_view: EditorView): boolean {
  return false;
}

export const tableKeymap = keymap.of([
  { key: 'ArrowLeft', run: moveHorizontal('left') },
  { key: 'ArrowRight', run: moveHorizontal('right') },
  { key: 'ArrowUp', run: moveVertical('up') },
  { key: 'ArrowDown', run: moveVertical('down') },
  { key: 'PageUp', run: moveVerticalPage('up') },
  { key: 'PageDown', run: moveVerticalPage('down') },
  { key: 'Home', run: moveHorizontalPage('home') },
  { key: 'End', run: moveHorizontalPage('end') },
  { key: 'Tab', run: cmdTab },
  { key: 'Shift-Tab', run: cmdShiftTab }, 
  { key: 'Mod-c', run: copySelectionTSV },
]);

export const tableExtension = [
  colWidthsField,
  tableDecoField,
];