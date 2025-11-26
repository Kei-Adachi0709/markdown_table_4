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
  StateEffect,
  Transaction
} from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

// --- ロガー設定 (v2.9) ---
const LOG_STYLES = {
  info: 'color: #00d1b2; font-weight: bold;',
  action: 'color: #3298dc; font-weight: bold;',
  success: 'color: #48c774; font-weight: bold;',
  warn: 'color: #ffdd57; font-weight: bold; background: #333;',
  error: 'color: #ff3860; font-weight: bold; background: #ffe5e5; padding: 4px; border: 1px solid #f00;',
  debug: 'color: #aaa; font-style: italic;',
  hover: 'color: #ff00ff; font-weight: bold;' 
};

function logInfo(msg: string, ...args: any[]) {
  console.log(`%c[TableExt:INFO] ${msg}`, LOG_STYLES.info, ...args);
}

function logAction(msg: string, ...args: any[]) {
  console.log(`%c[TableExt:ACTION] ${msg}`, LOG_STYLES.action, ...args);
}

function logSuccess(msg: string, ...args: any[]) {
  console.log(`%c[TableExt:OK] ${msg}`, LOG_STYLES.success, ...args);
}

function logWarn(msg: string, ...args: any[]) {
  console.warn(`%c[TableExt:WARN] ${msg}`, LOG_STYLES.warn, ...args);
}

function logError(msg: string, ...args: any[]) {
  console.error(`%c[TableExt:ERROR] ${msg}`, LOG_STYLES.error, ...args);
  if (args.length > 0 && args[0] instanceof Error) {
    console.error(args[0].stack);
  }
}

function logDebug(msg: string, ...args: any[]) {
  console.log(`%c[TableExt:DEBUG] ${msg}`, LOG_STYLES.debug, ...args);
}

// --- 診断用ユーティリティ ---
let lastHoverLogTime = 0;
function logHandleDebug(e: MouseEvent, container: HTMLElement | null) {
  const now = Date.now();
  if (now - lastHoverLogTime < 500) return; // ログ過多防止
  lastHoverLogTime = now;

  const x = e.clientX;
  const y = e.clientY;
  const target = document.elementFromPoint(x, y);
  
  // マウス直下の要素
  let targetInfo = 'null';
  if (target) {
    targetInfo = `${target.tagName.toLowerCase()}.${Array.from(target.classList).join('.')}`;
  }

  // 近くにあるハンドルの検出
  let nearbyHandleInfo = 'None';
  if (container) {
    const handles = container.querySelectorAll('.cm-drag-handle');
    let minDist = 1000;
    let closestHandle: Element | null = null;

    handles.forEach(h => {
      const rect = h.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.sqrt(Math.pow(x - cx, 2) + Math.pow(y - cy, 2));
      if (dist < minDist) {
        minDist = dist;
        closestHandle = h;
      }
    });

    if (closestHandle && minDist < 50) {
      const h = closestHandle as HTMLElement;
      const rect = h.getBoundingClientRect();
      nearbyHandleInfo = `Dist:${minDist.toFixed(1)}px, Class:${h.className}, Rect:[${rect.left.toFixed(0)},${rect.top.toFixed(0)},${rect.width.toFixed(0)}x${rect.height.toFixed(0)}], Z-Index:${getComputedStyle(h).zIndex}`;
    }
  }

  console.log(`%c[HANDLE_DEBUG] Mouse:(${x},${y}) Target:${targetInfo} | NearestHandle: ${nearbyHandleInfo}`, LOG_STYLES.hover);
}

console.log('%c TableExtension Loaded (Fix v2.9 - Undo Fix & Deep Debug) ', 'background: #6e40aa; color: #fff; font-weight: bold; padding: 4px;');

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

type DragState = {
  type: 'col' | 'row' | null;
  fromIndex: number;
  isDragging: boolean;
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

function serializeTable(
  headers: string[], 
  aligns: Align[], 
  rows: string[][]
): string {
  const escape = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  
  if (headers.length === 0 && rows.length === 0) return '';

  const colCount = headers.length;
  const resultLines: string[] = [];

  const formatLine = (cells: string[]) => {
    return '| ' + cells.map(c => c).join(' | ') + ' |';
  };

  resultLines.push(formatLine(headers.map(escape)));
  
  const safeAligns = Array.from({ length: colCount }, (_, i) => aligns[i] ?? null);
  
  const delimCells = safeAligns.map((a) => {
    if (a === 'left') return ':---';
    if (a === 'right') return '---:';
    if (a === 'center') return ':---:';
    return '---';
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
  
  const parent = rowEl.parentElement;
  if (parent && parent.tagName === 'THEAD') {
      return { row: null, col };
  } else if (parent && parent.tagName === 'TBODY') {
      return { row: rowEl.sectionRowIndex, col };
  }
  
  const table = rowEl.closest('table');
  const theadRowCount = table?.tHead?.rows.length ?? 0;
  return { row: rowEl.rowIndex - theadRowCount, col };
}

function getFromFromContainer(container: HTMLElement | null): number | null {
  if (!container || !container.dataset.from) return null;
  return parseInt(container.dataset.from, 10);
}

class TableWidget extends WidgetType {
  private container: HTMLElement | null = null;
  private isOpeningContextMenu = false;
  private isProgrammaticFocus = false;
  private isDraggingSelection = false;
  
  private isInteracting = false; 

  private dragState: DragState = {
    type: null,
    fromIndex: -1,
    isDragging: false
  };

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
    return false;
  }

  // --- DnD Handlers ---
  
  private handleDragStart = (e: DragEvent, type: 'col' | 'row', index: number) => {
    logAction(`Drag Start: Type=${type}, Index=${index}`);
    e.stopPropagation(); 
    
    this.isInteracting = true;
    this.dragState = {
      type,
      fromIndex: index,
      isDragging: true
    };
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('application/x-cm-table-dnd', JSON.stringify({ type, index, from: this.block.from }));
    
    if (this.container) {
      this.container.classList.add('cm-table-dragging-active');
    }
  };

  private handleDragOver = (e: DragEvent, type: 'col' | 'row', index: number) => {
    if (!this.dragState.isDragging || this.dragState.type !== type) return;
    
    e.preventDefault(); 
    e.dataTransfer!.dropEffect = 'move';

    this.clearDropHighlights();

    if (this.dragState.fromIndex === index) return;

    const target = e.currentTarget as HTMLElement;
    if (type === 'col') {
      const cell = target.closest('th, td');
      if (cell) cell.classList.add('cm-drop-target');
    } else {
      const tr = target.closest('tr');
      if (tr) tr.classList.add('cm-drop-target');
    }
  };

  private handleDragLeave = (e: DragEvent) => {
    const target = e.currentTarget as HTMLElement;
    target.classList.remove('cm-drop-target');
    const tr = target.closest('tr');
    if (tr) tr.classList.remove('cm-drop-target');
  };

  private clearDropHighlights() {
    if (!this.container) return;
    const highlights = this.container.querySelectorAll('.cm-drop-target');
    highlights.forEach(el => el.classList.remove('cm-drop-target'));
  }

  private handleDrop = (e: DragEvent, view: EditorView, type: 'col' | 'row', toIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    this.clearDropHighlights();
    
    if (!this.dragState.isDragging || this.dragState.type !== type) {
        this.isInteracting = false;
        return;
    }

    const fromIndex = this.dragState.fromIndex;
    if (fromIndex === toIndex) {
      logInfo('Drop canceled: Dropped on same index');
      this.isInteracting = false;
      return;
    }

    logAction(`Drop Executed: ${type} from ${fromIndex} -> to ${toIndex}`);

    try {
      if (type === 'col') {
        this.moveColumn(view, fromIndex, toIndex);
      } else {
        this.moveRow(view, fromIndex, toIndex);
      }
    } catch (err) {
      logError('Drop Error', err);
    } finally {
      this.dragState = { type: null, fromIndex: -1, isDragging: false };
      if (this.container) this.container.classList.remove('cm-table-dragging-active');
      
      setTimeout(() => {
          this.isInteracting = false;
      }, 200);
    }
  };

  private handleDragEnd = (_e: DragEvent) => {
    this.clearDropHighlights();
    this.dragState = { type: null, fromIndex: -1, isDragging: false };
    if (this.container) this.container.classList.remove('cm-table-dragging-active');
    
    setTimeout(() => {
        this.isInteracting = false;
    }, 200);
  };

  // --- Move Logic ---
  
  private moveColumn(view: EditorView, from: number, to: number) {
    const fromPos = getFromFromContainer(this.container);
    if (fromPos === null) {
      logError('moveColumn: Cannot find block position');
      return;
    }

    const block = this.getBlockAtFrom(view.state, fromPos) ?? this.block;
    
    const moveArrayItem = <T>(arr: T[], fromIdx: number, toIdx: number): T[] => {
      const clone = [...arr];
      if (fromIdx < 0 || fromIdx >= clone.length) return clone;
      const safeTo = Math.max(0, Math.min(toIdx, clone.length - 1));
      if (fromIdx === safeTo) return clone;
      const [item] = clone.splice(fromIdx, 1);
      clone.splice(safeTo, 0, item);
      return clone;
    };

    try {
      const newHeaders = moveArrayItem(block.headers, from, to);
      const fullAligns = [...block.aligns];
      while (fullAligns.length < block.headers.length) fullAligns.push(null);
      const newAligns = moveArrayItem(fullAligns, from, to);

      const newRows = block.rows.map((row, rIdx) => {
        const fullRow = [...row];
        while (fullRow.length < block.headers.length) fullRow.push('');
        return moveArrayItem(fullRow, from, to);
      });
      
      let newWidths: number[] | null = null;
      if (this.widths && this.widths.length > 0) {
        const fullWidths = [...this.widths];
        while (fullWidths.length < block.headers.length) fullWidths.push(100);
        newWidths = moveArrayItem(fullWidths, from, to);
      }

      const updated: TableBlock = { ...block, headers: newHeaders, aligns: newAligns, rows: newRows };
      
      logSuccess(`Applied column move.`);
      
      this.dispatchReplace(view, fromPos, updated, newWidths, (latestFrom) => {
        const targetCol = Math.max(0, Math.min(to, newHeaders.length - 1));
        this.focusCellAt(view, latestFrom ?? fromPos, null, targetCol);
      });
    } catch (e) {
      logError('moveColumn error', e);
    }
  }

  private moveRow(view: EditorView, from: number, to: number) {
    const fromPos = getFromFromContainer(this.container);
    if (fromPos === null) return;

    const block = this.getBlockAtFrom(view.state, fromPos) ?? this.block;
    if (from < 0 || from >= block.rows.length) return;

    const safeTo = Math.max(0, Math.min(to, block.rows.length - 1));

    try {
      const newRows = [...block.rows];
      const [movedRow] = newRows.splice(from, 1);
      newRows.splice(safeTo, 0, movedRow);

      const updated: TableBlock = { ...block, rows: newRows };
      
      logSuccess('Applied row move.');
      this.dispatchReplace(view, fromPos, updated, null, (latestFrom) => {
        this.focusCellAt(view, latestFrom ?? fromPos, safeTo, 0);
      });
    } catch (e) {
      logError('moveRow error', e);
    }
  }

  // --- DOM Update ---

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    return false;
  }

  // --- Event Handling ---

  ignoreEvent(event: Event): boolean {
    if (event.type === 'keydown') {
        const ke = event as KeyboardEvent;
        if (ke.ctrlKey || ke.metaKey) {
            // Undo/Redo用にCodeMirrorへ通す
            return false; 
        }
        const key = ke.key;
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'PageUp', 'PageDown', 'Home', 'End'].includes(key)) {
            return false; 
        }
        if (key === 'Enter') return true;
        return false; 
    }
    
    if (event.type === 'mousedown') {
      const target = event.target as HTMLElement;
      if (target.classList.contains('cm-drag-handle') || target.classList.contains('cm-table-resizer')) {
        return true; 
      }
      return true; 
    }
    
    if (event.type === 'copy' || event.type === 'cut' || event.type === 'paste') return false;
    
    return true;
  }

  handleKeyDown(event: KeyboardEvent, view: EditorView) {
    // Empty
  }

  private dispatchReplace = (
    view: EditorView, 
    originFrom: number,
    updated: TableBlock, 
    newWidths: number[] | null = null,
    after?: (latestFrom?: number) => void
  ) => {
    setTimeout(() => {
      const initialFrom = originFrom;
      const latestBlock = parseTablesInDoc(view.state).find(b => b.from === initialFrom);
      
      if (!latestBlock) {
          logWarn('dispatchReplace: Block not found at', initialFrom);
          return;
      }
      
      const newText = serializeTable(updated.headers, updated.aligns, updated.rows);
      
      const changes = { from: latestBlock.from, to: latestBlock.to, insert: newText };
      
      // ★修正: Undoできるようにトランザクションアノテーションを明確に付与
      const finalSpec: TransactionSpec = {
          changes,
          effects: (newWidths && newFrom !== null) ? updateColWidthEffect.of({ from: newFrom, widths: newWidths }) : [],
          annotations: [
              Transaction.addToHistory.of(true),
              Transaction.userEvent.of("input")
          ]
      };

      // 非同期更新のため、最新のステートからupdateを作成
      const tr = view.state.update(finalSpec);
      view.dispatch(tr);
      
      // mapPosにはtrのchangesを使う
      const newFrom = tr.changes.mapPos(latestBlock.from, 1);
      
      if (after) {
          requestAnimationFrame(() => after(newFrom ?? latestBlock.from));
      }
    }, 0); 
  }

  public focusCellAt = (view: EditorView, from: number, row: number | null, col: number) => {
    let retries = 0;
    const poll = () => {
        const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`) as HTMLElement | null;
        if (container) {
            this.doFocus(container, row, col);
        } else {
            retries++;
            if (retries < 10) requestAnimationFrame(poll);
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
          this.isProgrammaticFocus = true;
          target.focus({ preventScroll: false });
          
          if (target.firstChild || target.textContent) {
            const s = window.getSelection();
            const r = document.createRange();
            r.selectNodeContents(target);
            r.collapse(false);
            s?.removeAllRanges();
            s?.addRange(r);
          }
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
  }

  private getBlockAtFrom = (state: EditorState, from: number): TableBlock | null => {
    const blocks = parseTablesInDoc(state);
    return blocks.find(b => b.from === from) ?? null;
  }

  // --- Selection & Mouse Handling ---
  private clearSelection() {
    if (this.selection.type !== 'none') {
      this.selection = { type: 'none', anchor: null, head: null, selectedRows: new Set(), selectedCols: new Set() };
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
        if (selected) cell.classList.add('cm-table-selected');
        else cell.classList.remove('cm-table-selected');
      });
    });
  }

  private startSelection(rc: { row: number | null; col: number }, type: 'col' | 'row' | 'rect') {
      this.selection.type = type;
      this.selection.anchor = rc;
      this.selection.head = rc;
      this.isDraggingSelection = true;
      this.updateSelectionRange();
  }

  private updateDragSelection(rc: { row: number | null; col: number }) {
      if (!this.isDraggingSelection || this.selection.type === 'none') return;
      if (this.selection.head?.row !== rc.row || this.selection.head?.col !== rc.col) {
          this.selection.head = rc;
          this.updateSelectionRange();
      }
  }

  private getMouseAction(e: MouseEvent): { type: 'col' | 'row' | 'cell' | null; index: number; rc: {row: number|null, col: number} | null } {
    const target = e.target as HTMLElement;
    if (target.classList.contains('cm-drag-handle')) {
        return { type: null, index: -1, rc: null };
    }

    const targetCell = target.closest('th, td') as HTMLElement | null;
    if (!targetCell) return { type: null, index: -1, rc: null };
    
    if (target.classList.contains('cm-table-resizer')) return { type: null, index: -1, rc: null };

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
    
    const COL_SELECT_EDGE = isHeader ? 15 : 0; 
    const ROW_SELECT_EDGE = isFirstCol ? 15 : 0; 

    if (offsetY < COL_SELECT_EDGE) return { type: 'col', index: rc.col, rc };
    if (offsetX < ROW_SELECT_EDGE) {
        if (rc.row !== null) return { type: 'row', index: rc.row, rc };
    }
    return { type: 'cell', index: -1, rc };
  }

  private handleMouseMove = (e: MouseEvent) => {
    // --- 診断ログ (デバッグ用) ---
    logHandleDebug(e, this.container);
    // -------------------------

    if (document.body.classList.contains('cm-table-resizing')) return;
    
    const target = e.target as HTMLElement;
    
    this.container?.querySelectorAll('.cm-drag-handle').forEach(h => {
        (h as HTMLElement).style.opacity = '';
    });

    const targetCell = target.closest('th, td') as HTMLTableCellElement | null;
    if (targetCell) {
        if (targetCell.tagName === 'TD' && targetCell.cellIndex === 0) {
            const rowHandle = targetCell.querySelector('.cm-drag-handle-row') as HTMLElement;
            if (rowHandle) rowHandle.style.opacity = '1';
        }
        if (targetCell.tagName === 'TH') {
            const colHandle = targetCell.querySelector('.cm-drag-handle-col') as HTMLElement;
            if (colHandle) colHandle.style.opacity = '1';
        }
    }

    if (this.isDraggingSelection) {
        if (targetCell) {
            const rc = getCellRC(targetCell);
            if (rc) {
                this.updateDragSelection(rc);
                e.preventDefault();
            }
        }
        return;
    }
    
    if (target.classList.contains('cm-drag-handle')) {
        target.style.cursor = 'grab';
        return;
    }

    if (this.container) this.container.style.cursor = 'default';
    if (targetCell) targetCell.style.cursor = 'text';
    
    const action = this.getMouseAction(e);
    if (action.type === 'col' && targetCell) targetCell.style.cursor = 's-resize'; 
    else if (action.type === 'row' && targetCell) targetCell.style.cursor = 'e-resize';
  }

  private handleMouseDown = (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains('cm-table-resizer')) return;
    if ((e.target as HTMLElement).classList.contains('cm-drag-handle')) return; 

    if (e.button !== 0) return;

    const action = this.getMouseAction(e);
    const onMouseUp = () => {
        this.isDraggingSelection = false;
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

  private createDragHandle(type: 'col' | 'row', index: number, view: EditorView): HTMLElement {
    const handle = document.createElement('div');
    handle.className = `cm-drag-handle cm-drag-handle-${type}`;
    handle.draggable = true;
    handle.contentEditable = 'false'; 
    
    // ★ハンドルスタイルの強化 (さらに大きく、最前面へ)
    handle.style.position = 'absolute';
    handle.style.zIndex = '2147483647'; // 最大値
    handle.style.backgroundColor = '#cbd5e1'; 
    handle.style.borderRadius = '3px';
    handle.style.transition = 'background-color 0.2s, opacity 0.2s';
    handle.style.opacity = '0.6'; // デフォルト視認性を少し上げる

    if (type === 'row') {
        handle.style.width = '14px'; // 少し幅広に
        handle.style.height = '18px';
        handle.style.left = '1px'; // 左端ギリギリ
        handle.style.top = '50%'; 
        handle.style.transform = 'translateY(-50%)';
        handle.style.cursor = 'grab';
        // クリックイベントを透過させない
        handle.style.pointerEvents = 'auto';
    } else {
        handle.style.width = '36px';
        handle.style.height = '10px';
        handle.style.left = '50%';
        handle.style.top = '-5px'; // 少し下げる
        handle.style.transform = 'translateX(-50%)';
        handle.style.cursor = 'grab';
        handle.style.pointerEvents = 'auto';
    }

    handle.addEventListener('mouseenter', () => {
        handle.style.backgroundColor = '#22d3ee'; 
        handle.style.opacity = '1';
    });
    handle.addEventListener('mouseleave', () => {
        handle.style.backgroundColor = '#cbd5e1';
        handle.style.opacity = '0.6';
    });

    handle.addEventListener('dragstart', (e) => this.handleDragStart(e, type, index));
    handle.addEventListener('dragend', this.handleDragEnd);
    return handle;
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
          
          this.isInteracting = true; 

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
              
              setTimeout(() => { this.isInteracting = false; }, 100);
          };
          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
      });
      return resizer;
  }

  // ... (buildCell, toDOM, etc. remain same, just ensuring they use createDragHandle with new styles)
  // ... buildCell ...
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
    el.style.position = 'relative'; 
    el.style.minWidth = '50px';
    el.style.textAlign = al ?? 'left';
    el.style.padding = '4px 8px';
    el.style.border = '1px solid #ccc';
    el.style.backgroundColor = tag === 'th' ? '#f0f0f0' : '#ffffff';
    el.style.outline = 'none';

    el.addEventListener('dragover', (e) => {
        if (this.dragState.type === 'col') {
            this.handleDragOver(e, 'col', col);
        } else if (this.dragState.type === 'row' && row !== null) {
            this.handleDragOver(e, 'row', row);
        }
    });

    el.addEventListener('drop', (e) => {
        if (this.dragState.type === 'col') {
            this.handleDrop(e, view, 'col', col);
        } else if (this.dragState.type === 'row' && row !== null) {
            this.handleDrop(e, view, 'row', row);
        }
    });

    el.addEventListener('dragleave', this.handleDragLeave);

    if (tag === 'th') {
      const handle = this.createDragHandle('col', col, view);
      el.appendChild(handle);
    }
    if (tag === 'td' && col === 0 && row !== null) {
      const handle = this.createDragHandle('row', row, view);
      el.appendChild(handle);
    }

    if (tag === 'th') {
        const resizer = this.createResizer(view, el, col);
        el.appendChild(resizer);
    }

    const contentSpan = document.createElement('span');
    contentSpan.className = 'cm-cell-content';
    contentSpan.textContent = text;
    contentSpan.style.display = 'inline-block';
    contentSpan.style.minWidth = '10px';
    contentSpan.style.width = '100%';
    el.appendChild(contentSpan);

    el.contentEditable = 'true';

    el.addEventListener('focus', () => {
      el.style.boxShadow = 'inset 0 0 0 2px #22d3ee'; 
      this.isProgrammaticFocus = false;
    });

    const extractValue = () => (contentSpan.textContent ?? '').replace(/\r?\n/g, ' ');
    
    const commit = (after?: (from: number) => void) => {
      const container = getTableWidgetContainer(el);
      const domFrom = getFromFromContainer(container);
      if (domFrom === null) return;

      const latestBlock = this.getBlockAtFrom(view.state, domFrom);
      if (!latestBlock) return;

      const currentValue = (tag === 'th' ? latestBlock.headers[col] : (latestBlock.rows[row!]?.[col] ?? ''));
      const newValue = extractValue();
      
      if (currentValue === newValue) {
          if (after) setTimeout(() => after(latestBlock.from), 0);
          return;
      }
      updateValue(newValue, after, domFrom);
    }

    el.addEventListener('blur', (e: FocusEvent) => {
      el.style.boxShadow = 'none';
      if (this.isProgrammaticFocus) return; 
      if (this.isInteracting) return;

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
        e.preventDefault();
        e.stopPropagation(); 
        
        const container = getTableWidgetContainer(el);
        if (!container) return;
        
        const rowCount = parseInt(container.dataset.rowCount || '0', 10);
        const rc = getCellRC(el);
        if (!rc || rc.row == null) return;
        
        const currentRow = rc.row;
        const currentCol = rc.col;
        
        commit((latestFrom) => {
             if (currentRow < rowCount - 1) {
                 this.focusCellAt(view, latestFrom, currentRow + 1, currentCol);
             } else {
                 const block = this.getBlockAtFrom(view.state, latestFrom);
                 if (!block) return;
                 const currentCols = Math.max(block.headers.length, ...block.rows.map(r => r.length));
                 const newRow = Array(currentCols).fill('');
                 const updated: TableBlock = { ...block, rows: [...block.rows, newRow] };
                 
                 this.dispatchReplace(view, latestFrom, updated, null, (finalFrom) => {
                     const newRowIndex = rowCount; 
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

  // ... toDOM ...
  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    this.container = container; 
    container.className = 'cm-md-table-widget';
    container.style.padding = '12px';
    container.style.border = '1px dashed #ddd';
    container.style.borderRadius = '4px';
    container.style.margin = '1em 0';
    container.style.overflowX = 'auto';
    container.style.minHeight = '20px';
    container.tabIndex = -1; 
    container.style.outline = 'none'; 
    
    container.addEventListener('mousemove', this.handleMouseMove);
    container.addEventListener('mousedown', this.handleMouseDown); 
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
      const onUpdate = (val: string, after: ((from: number) => void) | undefined, currentFrom: number) => {
        const currentBlock = this.getBlockAtFrom(view.state, currentFrom) ?? this.block;
        const newHeaders = headers.map((h, i) => (i === col ? val : h));
        const newAligns = aligns.slice();
        while(newAligns.length < newHeaders.length) newAligns.push(null);
        const updated: TableBlock = { ...currentBlock, headers: newHeaders, aligns: newAligns };
        
        this.dispatchReplace(view, currentFrom, updated, null, (latestFrom) => {
            if (after) after(latestFrom ?? currentFrom);
            else this.focusCellAt(view, latestFrom ?? currentFrom, null, col);
        });
      };

      const th = this.buildCell('th', text, col, null, aligns[col] ?? null, onUpdate, view);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    
    const tbody = document.createElement('tbody');
    this.block.rows.forEach((row, rIdx) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        const onUpdate = (val: string, after: ((from: number) => void) | undefined, currentFrom: number) => {
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
        };

        const td = this.buildCell('td', row[c] ?? '', c, rIdx, aligns[c] ?? null, onUpdate, view);
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

  // --- ContextMenu ---
  // ... (showContextMenu, insertRow, deleteRow, insertCol, deleteCol remain same)
  private showContextMenu = (view: EditorView, container: HTMLElement, rc: { row: number | null; col: number }, x: number, y: number) => {
    this.isOpeningContextMenu = true;
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

// Keymap helpers
function getActiveCellContext(view: EditorView) {
  const focused = document.activeElement;
  if (!focused || (focused.tagName !== 'TH' && focused.tagName !== 'TD')) return null;
  const container = getTableWidgetContainer(focused as HTMLElement);
  if (!container) return null;
  const rc = getCellRC(focused as HTMLElement);
  if (!rc) return null;
  const from = getFromFromContainer(container);
  if (from === null) return null;
  const colCount = parseInt(container.dataset.colCount!, 10);
  const rowCount = parseInt(container.dataset.rowCount!, 10);
  const block = parseTablesInDoc(view.state).find(b => b.from === from) ?? null;
  return { ...rc, from, colCount, rowCount, block, el: focused as HTMLElement };
}

export const tableKeymap = keymap.of([]);

export const tableExtension = [
  colWidthsField,
  tableDecoField,
];