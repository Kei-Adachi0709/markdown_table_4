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

console.log('%c TableExtension Loaded (Fixed v18: Delete Logic) ', 'background: #000080; color: #fff; font-weight: bold; padding: 4px;');

const logPrefix = '[TableExt]';
function log(msg: string, ...args: any[]) {
  console.log(`%c${logPrefix} ${new Date().toISOString().slice(11, 23)}`, 'color: #00d1b2; font-weight: bold;', msg, ...args);
}

function logError(msg: string, ...args: any[]) {
  console.error(`%c${logPrefix} [ERROR]`, 'color: #ff4444; font-weight: bold;', msg, ...args);
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

function serializeTable(
  headers: string[], 
  aligns: Align[], 
  rows: string[][]
): string {
  const escape = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  
  if (headers.length === 0 && rows.length === 0) return '';

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

  resultLines.push(formatLine(headers.map(escape)));
  
  const safeAligns = Array.from({ length: colCount }, (_, i) => aligns[i] ?? null);
  
  const delimCells = safeAligns.map((a, i) => {
    const w = colWidths[i] || 3;
    if (a === 'left') return ':' + '-'.repeat(w - 1);
    if (a === 'right') return '-'.repeat(w - 1) + ':';
    if (a === 'center') return ':' + '-'.repeat(w - 2) + ':';
    return '-'.repeat(w);
  });
  resultLines.push('| ' + delimCells.join(' | ') + ' |');
  
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

function getFromFromContainer(container: HTMLElement | null): number | null {
  if (!container || !container.dataset.from) return null;
  return parseInt(container.dataset.from, 10);
}

class TableWidget extends WidgetType {
  private container: HTMLElement | null = null;
  private isOpeningContextMenu = false;
  private isProgrammaticFocus = false;
  private isDragging = false;
  
  // ★ 削除ロジック用の状態追加
  private lastDeleteTime = 0;
  private DELETE_DOUBLE_CLICK_THRESHOLD = 500; // ms

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
      o.block.headers.length !== this.block.headers.length ||
      o.block.rows.length !== this.block.rows.length
    ) return false;

    if (o.block.headers.join('|') !== this.block.headers.join('|')) return false;
    if (o.block.rows.map(r => r.join('|')).join('||') !== this.block.rows.map(r => r.join('|')).join('||')) return false;

    const w1 = this.widths ?? [];
    const w2 = o.widths ?? [];
    if (w1.length !== w2.length) return false;
    for (let i = 0; i < w1.length; i++) {
      if (w1[i] !== w2[i]) return false;
    }
    return true;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const oldRowCount = parseInt(dom.dataset.rowCount || '0', 10);
    const oldColCount = parseInt(dom.dataset.colCount || '0', 10);
    const newRowCount = this.block.rows.length;
    const newColCount = Math.max(
        this.block.headers.length, 
        ...this.block.rows.map(r => r.length)
    );

    if (oldRowCount !== newRowCount || oldColCount !== newColCount) {
        return false; 
    }

    const table = dom.querySelector('table');
    if (!table) return false;

    // Header Update
    const thead = table.querySelector('thead');
    if (thead && thead.rows.length > 0) {
        const headerRow = thead.rows[0];
        for (let i = 0; i < headerRow.cells.length; i++) {
            const cell = headerRow.cells[i];
            const newText = this.block.headers[i] ?? '';
            if (document.activeElement !== cell && cell.textContent !== newText) {
                cell.textContent = newText;
            }
        }
    }

    // Body Update
    const tbody = table.querySelector('tbody');
    if (tbody) {
        for (let r = 0; r < tbody.rows.length; r++) {
            const row = tbody.rows[r];
            for (let c = 0; c < row.cells.length; c++) {
                const cell = row.cells[c];
                const newText = this.block.rows[r]?.[c] ?? '';
                if (document.activeElement !== cell && cell.textContent !== newText) {
                    cell.textContent = newText;
                }
            }
        }
    }

    dom.dataset.from = this.block.from.toString();
    this.container = dom;
    return true;
  }

  ignoreEvent(event: Event): boolean {
    if (event.type === 'keydown') {
        const key = (event as KeyboardEvent).key;
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'PageUp', 'PageDown', 'Home', 'End'].includes(key)) {
            return false; 
        }
        if (key === 'Enter') {
            return true;
        }
        // ★ DeleteキーもWidget内で処理する
        if (key === 'Delete' || key === 'Backspace') {
            return true;
        }
        if (key.length === 1 && !(event as KeyboardEvent).ctrlKey && !(event as KeyboardEvent).metaKey && !(event as KeyboardEvent).altKey) {
            return true;
        }
        return false;
    }
    if (event.type === 'mousedown') return true; 
    if (event.type === 'copy') return true;
    return true;
  }

  private dispatchReplace = (
    view: EditorView, 
    originFrom: number,
    updated: TableBlock, 
    newWidths: number[] | null = null,
    after?: (latestFrom?: number) => void
  ) => {
    log(`dispatchReplace: Scheduled. originFrom=${originFrom}`);
    setTimeout(() => {
      const initialFrom = originFrom;
      const latestBlock = parseTablesInDoc(view.state).find(b => b.from === initialFrom);
      if (!latestBlock) {
          logError(`dispatchReplace: Block not found at ${initialFrom}. Aborting.`);
          return;
      }
      
      const newText = serializeTable(updated.headers, updated.aligns, updated.rows);
      const changes = { from: latestBlock.from, to: latestBlock.to, insert: newText };
      
      const tempTr = view.state.update({ changes });
      const newFrom = tempTr.changes.mapPos(latestBlock.from, 1);
      
      const finalSpec: TransactionSpec = {
          changes,
          effects: (newWidths && newFrom !== null) 
              ? updateColWidthEffect.of({ from: newFrom, widths: newWidths }) 
              : []
      };
      
      log(`dispatchReplace: Dispatching changes... New From=${newFrom}`);
      view.dispatch(finalSpec);
      
      if (after) {
          requestAnimationFrame(() => {
              log('dispatchReplace: Calling after callback');
              after(newFrom ?? latestBlock.from);
          });
      }
    }, 0); 
  }

  public focusCellAt = (view: EditorView, from: number, row: number | null, col: number) => {
    log(`focusCellAt: Request focus -> from=${from}, row=${row}, col=${col}`);
    
    let retries = 0;
    const maxRetries = 10;
    
    const poll = () => {
        const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`) as HTMLElement | null;
        
        if (container) {
            this.doFocus(container, row, col);
        } else {
            retries++;
            if (retries < maxRetries) {
                requestAnimationFrame(poll);
            } else {
                logError(`focusCellAt: Gave up searching for container [from=${from}]`);
            }
        }
    };
    
    poll();
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
          log(`focusCellAt: Focusing target cell ${target.tagName}`);
          this.isProgrammaticFocus = true;
          target.focus({ preventScroll: false });
          
          if (target.firstChild instanceof Text) {
            const s = window.getSelection();
            const r = document.createRange();
            r.selectNodeContents(target);
            r.collapse(false);
            s?.removeAllRanges();
            s?.addRange(r);
          }
          
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } else {
          logError(`focusCellAt: Target cell not found in DOM.`);
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
        if (action.type !== 'cell') {
            this.container?.focus({ preventScroll: true });
        }
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
      if (!this.container) return;
      const currentFrom = getFromFromContainer(this.container);
      if (currentFrom === null) return;

      if (this.selection.type === 'none' || this.selection.selectedRows.size === 0) return;
      const currentBlock = this.getBlockAtFrom(view.state, currentFrom);
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
      } else if (newRows.length > 0) {
          newHeaders = newRows[0];
          newRows = newRows.slice(1);
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

  // ★ 削除実行ロジック
  private performDelete = (view: EditorView, mode: 'content' | 'structure') => {
      if (!this.container) return;
      const currentFrom = getFromFromContainer(this.container);
      if (currentFrom === null) return;

      if (this.selection.type === 'none' || this.selection.selectedRows.size === 0) return;
      const currentBlock = this.getBlockAtFrom(view.state, currentFrom);
      if (!currentBlock) return;

      log(`performDelete: mode=${mode}, selection=${this.selection.type}`);

      if (mode === 'content') {
          // 1回押し: 文字だけ消す (行/列の構造は維持)
          const targetRows = Array.from(this.selection.selectedRows);
          const targetCols = Array.from(this.selection.selectedCols);
          
          const newHeaders = [...currentBlock.headers];
          const newRows = currentBlock.rows.map(r => [...r]);

          targetCols.forEach(c => {
              if (targetRows.includes(-1)) {
                  if (newHeaders[c] !== undefined) newHeaders[c] = '';
              }
              targetRows.forEach(r => {
                  if (r >= 0 && newRows[r] && newRows[r][c] !== undefined) {
                      newRows[r][c] = '';
                  }
              });
          });

          const updated = { ...currentBlock, headers: newHeaders, rows: newRows };
          this.dispatchReplace(view, currentFrom, updated);

      } else {
          // 2回押し: 構造ごと削除 (行削除 / 列削除)
          // Rect選択の場合は、含まれる行・列をすべて消すか、構造を維持するかが難しいが、
          // 今回は「行選択なら行削除」「列選択なら列削除」を優先し、Rectの場合は文字削除のみとするか、
          // 要件に合わせて「選択範囲の行列そのものを消す」を実装する。
          // ここでは「行・列選択時」に構造削除を行う。
          
          let newHeaders = [...currentBlock.headers];
          let newAligns = [...currentBlock.aligns];
          let newRows = currentBlock.rows.map(r => [...r]);
          let newWidths: number[] | null = null;
          const currentWidths = (view.state.field(colWidthsField) ?? {})[currentFrom];
          if (currentWidths) newWidths = [...currentWidths];

          if (this.selection.type === 'row') {
              // 行削除
              const targetRows = Array.from(this.selection.selectedRows).sort((a, b) => b - a); // 後ろから消す
              targetRows.forEach(r => {
                  if (r === -1) {
                      // ヘッダー行は消せない（構造維持のため空にするだけにするか、テーブルごと消すか？
                      // 通常はヘッダー削除=テーブル削除になりうるが、ここでは空にするだけにしておく安全策
                      newHeaders.fill('');
                  } else {
                      if (r < newRows.length) newRows.splice(r, 1);
                  }
              });
          } else if (this.selection.type === 'col') {
              // 列削除
              const targetCols = Array.from(this.selection.selectedCols).sort((a, b) => b - a); // 後ろから消す
              targetCols.forEach(c => {
                  newHeaders.splice(c, 1);
                  newAligns.splice(c, 1);
                  newRows.forEach(row => row.splice(c, 1));
                  if (newWidths) newWidths.splice(c, 1);
              });
          } else {
              // Rect選択の場合の構造削除は複雑（テーブルが崩れる）ため、文字削除にとどめるか、
              // あるいは要件「行、列をマウスカーソルで範囲選択して」に従い、
              // Rect選択でも無理やり削除するか。
              // ここでは安全のため「Rect選択時の2回押し」は「文字削除（1回押しと同じ）」扱いとするか、
              // ユーザーの意図として「選択範囲が含まれる行/列をすべて消す」のは危険。
              // → 仕様上「行、列をマウスカーソルで範囲選択」とあるので、行選択・列選択モードのみ対象とするのが自然。
              log('performDelete: Rect selection structure delete is skipped/fallback to content clear.');
              this.performDelete(view, 'content');
              return;
          }

          const updated = { ...currentBlock, headers: newHeaders, aligns: newAligns, rows: newRows };
          this.dispatchReplace(view, currentFrom, updated, newWidths);
          this.clearSelection(); // 削除後は選択解除
      }
  }

  private handleKeyDown = (e: KeyboardEvent, view: EditorView) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
          if (this.selection.type !== 'none') {
              e.preventDefault();
              e.stopPropagation();
              this.performCopy(view);
          }
      }
      
      // ★ Deleteキー処理
      if (e.key === 'Delete' || e.key === 'Backspace') {
          if (this.selection.type !== 'none') {
              e.preventDefault();
              e.stopPropagation();
              
              const now = Date.now();
              const elapsed = now - this.lastDeleteTime;
              this.lastDeleteTime = now;

              if (elapsed < this.DELETE_DOUBLE_CLICK_THRESHOLD) {
                  // 2回押し (Structure Delete)
                  this.performDelete(view, 'structure');
              } else {
                  // 1回押し (Content Clear)
                  this.performDelete(view, 'content');
              }
          }
      }

      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab'].includes(e.key)) {
          this.clearSelection();
      }
  }

  toDOM(view: EditorView): HTMLElement {
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
      const th = this.buildCell('th', text, col, null, aligns[col] ?? null, (val, after, currentFrom) => {
        const currentBlock = this.getBlockAtFrom(view.state, currentFrom) ?? this.block;
        const newHeaders = headers.map((h, i) => (i === col ? val : h));
        const newAligns = aligns.slice();
        while(newAligns.length < newHeaders.length) newAligns.push(null);
        const updated: TableBlock = { ...currentBlock, headers: newHeaders, aligns: newAligns };
        
        this.dispatchReplace(view, currentFrom, updated, null, (latestFrom) => {
            if (after) after(latestFrom ?? currentFrom);
            else this.focusCellAt(view, latestFrom ?? currentFrom, null, col);
        });
      }, view);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    
    const tbody = document.createElement('tbody');
    this.block.rows.forEach((row, rIdx) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        const td = this.buildCell('td', row[c] ?? '', c, rIdx, aligns[c] ?? null, (val, after, currentFrom) => {
          const currentBlock = this.getBlockAtFrom(view.state, currentFrom) ?? this.block;
          const newRows = currentBlock.rows.map((r, i) => (i === rIdx ? [...r] : r.slice()));
          if (!newRows[rIdx]) newRows[rIdx] = Array(colCount).fill('');
          while(newRows[rIdx].length < colCount) newRows[rIdx].push('');
          newRows[rIdx][c] = val;
          const updated: TableBlock = { ...currentBlock, rows: newRows };
          
          this.dispatchReplace(view, currentFrom, updated, null, (latestFrom) => {
            if (after) after(latestFrom ?? currentFrom);
            else this.focusCellAt(view, latestFrom ?? currentFrom, rIdx, c);
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
          const container = getTableWidgetContainer(th);
          if (!container) return;
          
          const table = container.querySelector('table');
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
              const latestFrom = getFromFromContainer(container) ?? this.block.from;
              
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
    updateValue: (val: string, after: ((from: number) => void) | undefined, currentFrom: number) => void,
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
      const container = getTableWidgetContainer(el);
      const domFrom = getFromFromContainer(container);
      
      if (domFrom === null) {
          logError('commit: Failed to find container/from');
          return;
      }

      const latestBlock = this.getBlockAtFrom(view.state, domFrom);
      if (!latestBlock) {
          logError('commit: Block not found in state');
          return;
      }

      const currentValue = (tag === 'th' ? latestBlock.headers[col] : (latestBlock.rows[row!]?.[col] ?? ''));
      const newValue = extractValue();
      
      if (currentValue === newValue) {
          if (after) {
              setTimeout(() => {
                  after(latestBlock.from);
              }, 0);
          }
          return;
      }
      updateValue(newValue, after, domFrom);
    }

    el.addEventListener('blur', (e: FocusEvent) => {
      el.style.boxShadow = 'none';
      if (this.isProgrammaticFocus) return; 
      if (this.isOpeningContextMenu) {
        this.isOpeningContextMenu = false; 
        return; 
      }
      const relatedTarget = e.relatedTarget as HTMLElement | null;
      const container = getTableWidgetContainer(el);
      if (container && relatedTarget && container.contains(relatedTarget)) return; 
      if (!el.isConnected) return; 
      commit(); 
    });

    el.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      
      if (e.key === 'Enter') {
        log(`[DEBUG] Cell Keydown: Enter detected in buildCell listener`);
        e.preventDefault();
        e.stopPropagation(); 
        
        const container = getTableWidgetContainer(el);
        if (!container) {
            logError('keydown: Enter - Container not found');
            return;
        }
        
        const rowCount = parseInt(container.dataset.rowCount || '0', 10);
        const rc = getCellRC(el);
        if (!rc || rc.row == null) {
            logError('keydown: Enter - Cannot determine cell RC');
            return;
        }
        
        const currentRow = rc.row;
        const currentCol = rc.col;
        
        commit((latestFrom) => {
             if (currentRow < rowCount - 1) {
                 log(`Not last row. Moving focus to Row=${currentRow + 1}`);
                 this.focusCellAt(view, latestFrom, currentRow + 1, currentCol);
             } else {
                 log(`Last row detected. Adding new row.`);
                 
                 const block = this.getBlockAtFrom(view.state, latestFrom);
                 if (!block) {
                     logError('keydown: Enter - Block not found during row addition');
                     return;
                 }
                 
                 const currentCols = Math.max(block.headers.length, ...block.rows.map(r => r.length));
                 const newRow = Array(currentCols).fill('');
                 const updated: TableBlock = { ...block, rows: [...block.rows, newRow] };
                 
                 this.dispatchReplace(view, latestFrom, updated, null, (finalFrom) => {
                     const newRowIndex = rowCount; 
                     log(`Row added. Focusing Row=${newRowIndex}`);
                     this.focusCellAt(view, finalFrom ?? latestFrom, newRowIndex, currentCol);
                 });
             }
        });
        return;
      }
      
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
          this.clearSelection();
      }
    });
    return el;
  }

  private showContextMenu = (view: EditorView, container: HTMLElement, rc: { row: number | null; col: number }, x: number, y: number) => {
    const from = getFromFromContainer(container);
    if (from === null) return;

    document.querySelectorAll('.cm-table-menu').forEach((m) => m.remove());

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
    const from = getFromFromContainer(container);
    if (from === null) return;
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
    const colCount = Math.max(block.headers.length, ...block.rows.map(r => r.length));
    const at = where === 'above' ? row : row + 1;
    const newRows = block.rows.slice();
    newRows.splice(at, 0, Array(colCount).fill(''));
    const updated: TableBlock = { ...block, rows: newRows };
    this.dispatchReplace(view, from, updated, null, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, at, col));
  }

  private deleteRow = (view: EditorView, container: HTMLElement, row: number) => {
    const from = getFromFromContainer(container);
    if (from === null) return;
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
    if (block.rows.length === 0) return;
    const newRows = block.rows.slice();
    const focusRow = Math.max(0, Math.min(row, newRows.length - 2));
    newRows.splice(row, 1);
    const updated: TableBlock = { ...block, rows: newRows };
    this.dispatchReplace(view, from, updated, null, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, focusRow, 0));
  }

  private insertCol = (view: EditorView, container: HTMLElement, col: number, row: number | null, where: 'left' | 'right') => {
    const from = getFromFromContainer(container);
    if (from === null) return;
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
    this.dispatchReplace(view, from, updated, newWidths, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, row, at));
  }

  private deleteCol = (view: EditorView, container: HTMLElement, col: number) => {
    const from = getFromFromContainer(container);
    if (from === null) return;
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
    this.dispatchReplace(view, from, updated, newWidths, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, 0, newCol));
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
  const focused = document.activeElement;
  // log(`getActiveCellContext: ActiveElement is <${focused?.tagName.toLowerCase()}> className="${focused?.className}"`);

  if (!focused || (focused.tagName !== 'TH' && focused.tagName !== 'TD')) {
      // logError('getActiveCellContext: Focused element is not TH or TD');
      return null;
  }
  
  const container = getTableWidgetContainer(focused as HTMLElement);
  if (!container) {
      logError('getActiveCellContext: Table widget container not found for focused element');
      return null;
  }
  
  const rc = getCellRC(focused as HTMLElement);
  if (!rc) {
      logError('getActiveCellContext: Could not determine Row/Col index');
      return null;
  }
  
  const from = getFromFromContainer(container);
  if (from === null) {
      logError('getActiveCellContext: "data-from" attribute missing on container');
      return null;
  }

  const colCount = parseInt(container.dataset.colCount!, 10);
  const rowCount = parseInt(container.dataset.rowCount!, 10);
  
  const block = parseTablesInDoc(view.state).find(b => b.from === from) ?? null;
  if (!block) {
      logError(`getActiveCellContext: Block not found for from=${from}. Navigation might fail if structure info is needed.`);
  }
  
  return { ...rc, from, colCount, rowCount, block, el: focused as HTMLElement };
}

function focusCell(view: EditorView, from: number, row: number | null, col: number) {
  const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`) as HTMLElement | null;
  if (!container) {
      logError(`focusCell: Container not found for from=${from}`);
      return;
  }
  let target: HTMLElement | null = null;
  if (row == null || row < 0) {
    target = container.querySelector(`thead tr > :nth-child(${col + 1})`) as HTMLElement | null;
  } else {
    const tr = container.querySelector(`tbody tr:nth-child(${row + 1})`) as HTMLElement | null;
    if (tr) target = tr.children[col] as HTMLElement | null;
  }
  if (target) {
    log(`focusCell: Navigating to Row=${row}, Col=${col}`);
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
  } else {
      logError(`focusCell: Target cell not found. Row=${row}, Col=${col}`);
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
    log(`moveHorizontal called: ${dir}`);
    const ctx = getActiveCellContext(view);
    if (!ctx) {
        log('moveHorizontal: No context found');
        return false;
    }
    const { from, row, col, colCount } = ctx;
    const nCol = clamp(col + (dir === 'left' ? -1 : 1), 0, colCount - 1);
    if (nCol === col) {
        log('moveHorizontal: Boundary reached');
        return false; 
    }
    focusCell(view, from, row, nCol);
    return true;
  };
}

function moveVertical(dir: 'up' | 'down') {
  return (view: EditorView): boolean => {
    log(`moveVertical called: ${dir}`);
    const ctx = getActiveCellContext(view);
    if (!ctx) {
        log('moveVertical: No context found (ActiveElement check failed)');
        return false;
    }
    const { from, row, col, rowCount } = ctx;
    let nRow: number | null = row ?? -1; 
    if (dir === 'up') {
      if (nRow === 0) nRow = null; 
      else if (nRow > 0) nRow = nRow - 1; 
      else {
          log('moveVertical: Top boundary reached');
          return false; 
      }
    } else {
      if (nRow === null) nRow = 0; 
      else if (nRow < rowCount - 1) nRow = nRow + 1; 
      else {
          log('moveVertical: Bottom boundary reached');
          return false; 
      }
    }
    focusCell(view, from, nRow, col);
    return true;
  };
}

function moveVerticalPage(dir: 'up' | 'down') {
    return (view: EditorView): boolean => {
        log(`moveVerticalPage called: ${dir}`);
        const ctx = getActiveCellContext(view);
        if (!ctx) {
            logError('moveVerticalPage: Context not found');
            return false;
        }
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
        log(`moveHorizontalPage called: ${dir}`);
        const ctx = getActiveCellContext(view);
        if (!ctx) {
            logError('moveHorizontalPage: Context not found');
            return false;
        }
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