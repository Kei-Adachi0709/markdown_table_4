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
  RangeValue,
  RangeSet
} from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

// ---- デバッグ用プレフィックス ----
const logPrefix = '[TableExt]';

// ---- Types and Helpers ----

type Align = 'left' | 'right' | 'center' | null;

interface TableBlock {
  from: number;
  to: number;
  headers: string[];
  aligns: Align[];
  rows: string[][];
}

// (中略: serializeTable, parseTablesInDoc, getTableWidgetContainer, getCellRC, clamp は v13 から変更なし)
function serializeTable(block: TableBlock): string {
  const colCount = Math.max(block.headers.length, ...block.rows.map(r => r.length));
  const headers = Array.from({ length: colCount }, (_, i) => block.headers[i] ?? '');
  const aligns = Array.from({ length: colCount }, (_, i) => block.aligns[i] ?? null);
  const rows = block.rows.map(row => Array.from({ length: colCount }, (_, i) => row[i] ?? ''));
  const escape = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines: string[] = [];
  lines.push(`| ${headers.map(escape).join(' | ')} |`);
  lines.push(`| ${aligns
    .map(a => {
      if (a === 'left') return ':---';
      if (a === 'right') return '---:';
      if (a === 'center') return ':---:';
      return '---';
    })
    .join(' | ')} |`);
  rows.forEach(row => {
    lines.push(`| ${row.map(escape).join(' | ')} |`);
  });
  return lines.join('\n');
}
function parseTablesInDoc(state: EditorState): TableBlock[] {
  console.log(`${logPrefix} parseTablesInDoc()`);
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
      let stateLoop: 'header' | 'align' | 'row' = 'header';
      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        const lineText = state.doc.sliceString(child.from, child.to); 
        if (child.name === 'TableHeader') {
          const parts = lineText.split('|').map(s => s.trim());
          if (parts[0] === '') parts.shift();
          if (parts[parts.length - 1] === '') parts.pop();
          headers.push(...parts);
          stateLoop = 'align';
        } else if (child.name === 'TableDelim') {
          const parts = lineText.split('|').map(s => s.trim());
          if (parts[0] === '') parts.shift();
          if (parts[parts.length - 1] === '') parts.pop();
          parts.forEach(p => {
            const left = p.startsWith(':');
            const right = p.endsWith(':');
            if (left && right) aligns.push('center');
            else if (left) aligns.push('left');
            else if (right) aligns.push('right');
            else aligns.push(null);
          });
          stateLoop = 'row';
        } else if (child.name === 'TableRow') {
          const parts = lineText.split('|').map(s => s.trim());
          if (parts[0] === '') parts.shift();
          if (parts[parts.length - 1] === '') parts.pop();
          rows.push(parts);
        }
      }
      blocks.push({ from, to, headers, aligns, rows });
    }
  });
  console.log(`${logPrefix} parseTablesInDoc: ${blocks.length} tables found.`);
  return blocks;
}
function getTableWidgetContainer(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.closest<HTMLElement>('.cm-md-table-widget');
}
function getCellRC(el: HTMLElement | null): { row: number | null; col: number } | null {
  if (!el || (el.tagName !== 'TH' && el.tagName !== 'TD')) return null;
  const col = el.cellIndex;
  const rowEl = el.closest('tr');
  if (!rowEl) return null;
  const head = rowEl.closest('thead');
  if (head) return { row: null, col };
  return { row: rowEl.rowIndex - 1, col }; 
}
function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

// ---- Widget ----
class TableWidget extends WidgetType {
  private container: HTMLElement | null = null;
  // (v12) 右クリックメニューフラグ
  private isOpeningContextMenu = false;
  
  constructor(private block: TableBlock) {
    super();
    console.log(`${logPrefix} new TableWidget() [from: ${block.from}, to: ${block.to}]`);
  }

  eq(other: WidgetType): boolean {
    // (中略: v13 から変更なし)
    const eq = (o: TableWidget) => {
       if (o.block.from !== this.block.from ||
           o.block.to !== this.block.to ||
           o.block.headers.join('|') !== this.block.headers.join('|') ||
           o.block.rows.map(r => r.join('|')).join('||') !== this.block.rows.map(r => r.join('|')).join('||')
       ) return false;
       return true;
    }
    const result = (other instanceof TableWidget) && eq(other);
    console.log(`${logPrefix} eq(): ${result}`);
    return result;
  }

  ignoreEvent(event: Event): boolean {
    // (中略: v13 から変更なし)
    const ignored = event.type !== 'keydown' && event.type !== 'keyup';
    console.log(`${logPrefix} ignoreEvent(${event.type}): ${ignored}`);
    return ignored;
  }

  // (v8 の dispatchReplace: RangeError 対策済み)
  private dispatchReplace = (view: EditorView, updated: TableBlock, after?: (latestFrom?: number) => void) => {
    // (中略: v13 から変更なし)
    console.log(`${logPrefix} dispatchReplace() CALLED`);
    setTimeout(() => {
      const initialFrom = this.block.from;
      console.log(`${logPrefix} dispatchReplace(async): Searching block at initialFrom: ${initialFrom}`);
      
      const latestBlock = parseTablesInDoc(view.state).find(b => b.from === initialFrom);
      if (!latestBlock) {
           console.error(`${logPrefix} dispatchReplace(async): Block not found at ${initialFrom}!`);
           return;
      }
      
      console.log(`${logPrefix} dispatchReplace(async): Block found [from: ${latestBlock.from}, to: ${latestBlock.to}]`);
      const newText = serializeTable({ ...updated, from: latestBlock.from, to: latestBlock.to });
      const tr: TransactionSpec = {
        changes: { from: latestBlock.from, to: latestBlock.to, insert: newText }
      };
      
      console.log(`${logPrefix} dispatchReplace(async): DISPATCHING...`);
      view.dispatch(tr);
      console.log(`${logPrefix} dispatchReplace(async): DISPATCHED`);
      
      if (after) {
          console.log(`${logPrefix} dispatchReplace(async): Calling 'after' callback...`);
          after(latestBlock.from);
      }
    }, 0); 
  }

  // (v8 の focusCellAt)
  private focusCellAt = (view: EditorView, from: number, row: number | null, col: number) => {
    // (中略: v13 から変更なし)
    console.log(`${logPrefix} focusCellAt(from: ${from}, row: ${row}, col: ${col})`);
    try {
      const tryFocus = () => {
        console.log(`${logPrefix} focusCellAt(async): Trying to focus...`);
        const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`) as HTMLElement | null;
        if (!container) {
          console.warn(`${logPrefix} focusCellAt(async): Container [data-from="${from}"] not found.`);
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
          console.log(`${logPrefix} focusCellAt(async): Target found, calling .focus()`);
          target.focus();
          if (target.firstChild instanceof Text) {
            const s = window.getSelection();
            const r = document.createRange();
            r.selectNodeContents(target);
            r.collapse(false);
            s?.removeAllRanges();
            s?.addRange(r);
          }
        } else {
          console.warn(`${logPrefix} focusCellAt(async): Target cell (row: ${row}, col: ${col}) not found.`);
        }
      };
      setTimeout(tryFocus, 0);
    } catch (e) {
      console.error(`${logPrefix} focusCellAt: Error`, e);
    }
  }

  // (v8 の getBlockAtFrom)
  private getBlockAtFrom = (state: EditorState, from: number): TableBlock | null => {
    // (中略: v13 から変更なし)
    console.log(`${logPrefix} getBlockAtFrom(from: ${from})`);
    const blocks = parseTablesInDoc(state);
    const block = blocks.find(b => b.from === from) ?? null;
    if (!block) console.warn(`${logPrefix} getBlockAtFrom: Block not found at ${from}`);
    return block;
  }

  // ---- Row/Col ops ----
  // (v8 の Row/Col 操作: RangeError 対策済み)
  private insertRow = (view: EditorView, container: HTMLElement, col: number, row: number, where: 'above' | 'below') => {
    // (中略: v13 から変更なし)
    console.log(`${logPrefix} insertRow(row: ${row}, where: ${where})`);
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
    const colCount = Math.max(block.headers.length, ...block.rows.map(r => r.length));
    const at = where === 'above' ? row : row + 1;
    const newRows = block.rows.slice();
    newRows.splice(at, 0, Array(colCount).fill(''));
    const updated: TableBlock = { ...block, rows: newRows };
    this.dispatchReplace(view, updated, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, at, col));
  }
  private deleteRow = (view: EditorView, container: HTMLElement, row: number) => {
    // (中略: v13 から変更なし)
    console.log(`${logPrefix} deleteRow(row: ${row})`);
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
    if (block.rows.length === 0) return;
    const newRows = block.rows.slice();
    const focusRow = Math.max(0, Math.min(row, newRows.length - 2));
    newRows.splice(row, 1);
    const updated: TableBlock = { ...block, rows: newRows };
    this.dispatchReplace(view, updated, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, focusRow, 0));
  }
  private insertCol = (view: EditorView, container: HTMLElement, col: number, where: 'left' | 'right') => {
    // (中略: v13 から変更なし)
    console.log(`${logPrefix} insertCol(col: ${col}, where: ${where})`);
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
    this.dispatchReplace(view, updated, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, 0, at));
  }
  private deleteCol = (view: EditorView, container: HTMLElement, col: number) => {
    // (中略: v13 から変更なし)
    console.log(`${logPrefix} deleteCol(col: ${col})`);
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
    this.dispatchReplace(view, updated, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, 0, newCol));
  }

  // (v10 の showContextMenu)
  private showContextMenu = (view: EditorView, container: HTMLElement, rc: { row: number | null; col: number }, x: number, y: number) => {
    // (中略: v13 から変更なし)
    console.log(`${logPrefix} showContextMenu(row: ${rc.row}, col: ${rc.col})`);
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
          console.log(`${logPrefix} Menu item click: ${label}`);
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
        console.log(`${logPrefix} Closing context menu (click outside)`);
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
    menu.appendChild(mkItem('左に列を挿入', () => this.insertCol(view, container, rc.col, 'left'), colOpsEnabled));
    menu.appendChild(mkItem('右に列を挿入', () => this.insertCol(view, container, rc.col, 'right'), colOpsEnabled));
    menu.appendChild(mkItem('列を削除', () => this.deleteCol(view, container, rc.col), colOpsEnabled));
    document.body.appendChild(menu);
  }

  // ★★★ 修正 (v14): `blur` と `contextmenu` のロジックを修正 ★★★
  private buildCell = (
    tag: 'th' | 'td',
    text: string,
    col: number,
    row: number | null,
    al: Align,
    updateValue: (val: string) => void,
    view: EditorView
  ) => {
    // (中略: v13 から変更なし)
    console.log(`${logPrefix} buildCell(tag: ${tag}, row: ${row}, col: ${col})`);
    const el = document.createElement(tag);
    el.contentEditable = 'true';
    el.textContent = text;
    el.style.minWidth = '50px';
    el.style.textAlign = al ?? 'left';
    el.style.padding = '4px 8px';
    el.style.border = '1px solid #ccc';
    el.style.position = 'relative'; 
    el.style.outline = 'none';

    el.addEventListener('focus', () => {
      console.log(`${logPrefix} FOCUS (row: ${row}, col: ${col})`);
      el.style.boxShadow = 'inset 0 0 0 2px #007bff';
    });
    
    const extractValue = () => (el.textContent ?? '').replace(/\r?\n/g, ' ');
    const commit = () => {
      console.log(`${logPrefix} commit() CALLED (row: ${row}, col: ${col})`);
      updateValue(extractValue());
    }
    
    // (v14 の blur リスナー)
    el.addEventListener('blur', (e: FocusEvent) => {
      el.style.boxShadow = 'none';

      // ★ (v14) もし `contextmenu` が *直前* に発火していたら、
      //    この blur はメニューを開くためのものなので、コミットをスキップする
      if (this.isOpeningContextMenu) {
        console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Skipped commit (blur was from context menu)`);
        // ★ (v14) フラグをここでリセット
        this.isOpeningContextMenu = false; 
        return; 
      }
      
      const relatedTarget = e.relatedTarget as HTMLElement | null;
      const container = this.container; 

      if (container && relatedTarget && container.contains(relatedTarget)) {
        // (v10) フォーカスがテーブル内の別のセルに移動した (e.g. 矢印キー)
        console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Skipped commit (focus moved to another cell)`);
        return; 
      }
      
      if (!el.isConnected) {
        // (v11) セルが DOM から切り離されていたらコミットしない
        console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Skipped commit (element is disconnected)`);
        return; 
      }

      // (v10) フォーカスがテーブル外に移動した、または不明
      console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Committing (focus left table or lost)`);
      commit(); 
    });

    el.addEventListener('input', () => {
      // noop
    });
    
    // (v9 の keydown リスナー: 矢印キーでは commit しない)
    el.addEventListener('keydown', (e) => {
      // (中略: v13 から変更なし)
      console.log(`${logPrefix} KEYDOWN (row: ${row}, col: ${col}): ${e.key}`);
      if (e.key === 'Enter') {
        e.preventDefault(); 
        console.log(`${logPrefix} KEYDOWN: Enter. Committing and blurring...`);
        commit(); // Enter 時はコミット
        (el as HTMLElement).blur(); // キーマップ(cmdEnter)を起動
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab'].includes(e.key)) {
          console.log(`${logPrefix} KEYDOWN: Arrow/Tab. Passing event to keymap.`);
      }
    });

    // (v14 の mousedown リスナー)
    el.addEventListener('mousedown', (e) => {
      console.log(`${logPrefix} mousedown (row: ${row}, col: ${col})`);
      // ★ (v14) 左クリックは必ずメニューフラグをリセットする
      this.isOpeningContextMenu = false;
    });

    // (v14 の contextmenu リスナー)
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      console.log(`${logPrefix} contextmenu (row: ${row}, col: ${col})`);
      
      // ★ (v14) これから `blur` が発生することをフラグで伝える
      this.isOpeningContextMenu = true;
      
      const container = getTableWidgetContainer(el);
      if (!container) return;
      const rc = getCellRC(el);
      if (!rc) return;
      this.showContextMenu(view, container, rc, e.clientX, e.clientY);

      // ★ (v14) v12/v13 で競合の原因だった setTimeout() を削除
    });

    return el;
  }

  // ★ toDOM はアロー関数 ( = ) に *しない*
  toDOM(view: EditorView): HTMLElement {
    // (中略: v13 から変更なし)
    console.log(`${logPrefix} toDOM() [from: ${this.block.from}]`);
    const container = document.createElement('div');
    this.container = container; 
    
    container.className = 'cm-md-table-widget';
    container.style.padding = '4px';
    container.style.border = '1px dashed #ddd';
    container.style.borderRadius = '4px';
    container.style.margin = '1em 0';

    const table = document.createElement('table');
    table.style.borderCollapse = 'collapse';
    table.style.width = '100%';

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    trh.style.backgroundColor = '#f8f8f8';

    const colCount = Math.max(
      this.block.headers.length,
      this.block.aligns.length,
      ...this.block.rows.map(r => r.length)
    );
    container.dataset.from = this.block.from.toString();
    container.dataset.colCount = colCount.toString();
    container.dataset.rowCount = this.block.rows.length.toString();

    const headers = Array.from({ length: colCount }, (_, i) => this.block.headers[i] ?? '');
    const aligns = Array.from({ length: colCount }, (_, i) => this.block.aligns[i] ?? null);

    headers.forEach((text, col) => {
      const th = this.buildCell('th', text, col, null, aligns[col] ?? null, (val) => {
        console.log(`${logPrefix} updateValue (Header col: ${col}): '${val}'`);
        const currentBlock = this.getBlockAtFrom(view.state, this.block.from) ?? this.block;
        const updated: TableBlock = {
          ...currentBlock,
          headers: headers.map((h, i) => (i === col ? val : h)),
          aligns
        };
        this.dispatchReplace(view, updated, (latestFrom) => this.focusCellAt(view, latestFrom ?? this.block.from, null, col));
      }, view);
      trh.appendChild(th);
    });
    thead.appendChild(trh);

    const tbody = document.createElement('tbody');
    this.block.rows.forEach((row, rIdx) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        const td = this.buildCell('td', row[c] ?? '', c, rIdx, aligns[c] ?? null, (val) => {
          console.log(`${logPrefix} updateValue (Body row: ${rIdx}, col: ${c}): '${val}'`);
          const currentBlock = this.getBlockAtFrom(view.state, this.block.from) ?? this.block;
          const newRows = currentBlock.rows.map((r, i) => (i === rIdx ? [...r] : r.slice()));
          if (!newRows[rIdx]) newRows[rIdx] = Array(colCount).fill('');
          newRows[rIdx][c] = val;
          const updated: TableBlock = { ...currentBlock, rows: newRows };
          this.dispatchReplace(view, updated, (latestFrom) => this.focusCellAt(view, latestFrom ?? this.block.from, rIdx, c));
        }, view);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    const styleSel = document.createElement('style');
    styleSel.textContent = `
      .cm-md-table-widget td[data-selected="true"],
      .cm-md-table-widget th[data-selected="true"] {
        background-color: #d0e0ff;
      }
    `;
    table.appendChild(thead);
    table.appendChild(tbody);
    container.appendChild(styleSel);
    container.appendChild(table);
    
    return container;
  }
}

// ---- Decorations ----

// (v10 の buildDecorations)
function buildDecorations(state: EditorState): DecorationSet {
  // (中略: v13 から変更なし)
  console.log(`${logPrefix} buildDecorations()`);
  const builder = new RangeSetBuilder<Decoration>();
  const blocks = parseTablesInDoc(state);
  for (const block of blocks) {
    builder.add(
      block.from,
      block.to,
      Decoration.replace({
        widget: new TableWidget(block)
      })
    );
  }
  return builder.finish();
}

// (v10 の tableDecoField)
export const tableDecoField = StateField.define<DecorationSet>({
  // (中略: v13 から変更なし)
  create(state) {
    console.log(`${logPrefix} tableDecoField.create()`);
    return buildDecorations(state);
  },
  update(value, tr) {
    console.log(`${logPrefix} tableDecoField.update()`);
    if (!tr.docChanged) return value;
    console.log(`${logPrefix} tableDecoField.update(): doc changed, rebuilding decorations.`);
    return buildDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f)
});

// ---- Keymap ----

// (v10 の getActiveCellContext)
function getActiveCellContext(view: EditorView) {
  // (中略: v13 から変更なし)
  console.log(`${logPrefix} getActiveCellContext()`);
  const sel = view.state.selection.main;
  const focused = view.hasFocus ? document.activeElement : null;
  if (!focused || (focused.tagName !== 'TH' && focused.tagName !== 'TD')) {
    console.log(`${logPrefix} getActiveCellContext: FAILED (No cell focused)`);
    return null;
  }
  const container = getTableWidgetContainer(focused as HTMLElement);
  if (!container) {
    console.log(`${logPrefix} getActiveCellContext: FAILED (No container found)`);
    return null;
  }
  const rc = getCellRC(focused as HTMLElement);
  if (!rc) {
    console.log(`${logPrefix} getActiveCellContext: FAILED (No RC found)`);
    return null;
  }
  const from = parseInt(container.dataset.from!, 10);
  const colCount = parseInt(container.dataset.colCount!, 10);
  const rowCount = parseInt(container.dataset.rowCount!, 10);
  const block = parseTablesInDoc(view.state).find(b => b.from === from) ?? null;
  if (!block) {
    console.log(`${logPrefix} getActiveCellContext: FAILED (No block found at ${from})`);
    return null;
  }
  console.log(`${logPrefix} getActiveCellContext: SUCCESS (row: ${rc.row}, col: ${rc.col})`);
  return { ...rc, from, colCount, rowCount, block };
}

// (v10 の focusCell)
function focusCell(view: EditorView, from: number, row: number | null, col: number) {
  // (中略: v13 から変更なし)
  console.log(`${logPrefix} focusCell(from: ${from}, row: ${row}, col: ${col})`);
  const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`) as HTMLElement | null;
  if (!container) {
    console.warn(`${logPrefix} focusCell: Container [data-from="${from}"] not found.`);
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
    setTimeout(() => {
        console.log(`${logPrefix} focusCell(async): Calling .focus() on target...`);
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
     console.warn(`${logPrefix} focusCell: Target cell (row: ${row}, col: ${col}) not found in container.`);
  }
}

// (v11 の cmdEnter: 復活済み)
function cmdEnter(view: EditorView): boolean {
  // (中略: v13 から変更なし)
  console.log(`${logPrefix} keymap: Enter`);
  const ctx = getActiveCellContext(view);
  if (!ctx) {
     console.log(`${logPrefix} keymap: Enter FAILED (No active cell)`);
     return false;
  }
  const currentBlock = ctx.block; 
  if (!currentBlock) return false;
  const { from, row, col, rowCount, colCount } = ctx;
  let curRow = row ?? -1;
  let nRow = curRow + 1;

  if (nRow >= rowCount) {
    console.log(`${logPrefix} keymap: Enter (End of table) -> Add row`);
    const newRow = Array(colCount).fill('');
    const updated: TableBlock = { ...currentBlock, rows: [...currentBlock.rows, newRow] };
    const newText = serializeTable(updated);
    setTimeout(() => {
        const latestBlock = parseTablesInDoc(view.state).find(b => b.from === currentBlock.from);
        if (!latestBlock) return;
        view.dispatch({ changes: { from: latestBlock.from, to: latestBlock.to, insert: newText } });
        focusCell(view, latestBlock.from, rowCount, col);
    }, 0);
    return true;
  } else {
    console.log(`${logPrefix} keymap: Enter -> Move to next row`);
    focusCell(view, from, nRow, col);
    return true;
  }
}

// (v10 の Tab, Shift+Tab, 矢印キー移動)
function cmdTab(view: EditorView): boolean {
  // (中略: v13 から変更なし)
  console.log(`${logPrefix} keymap: Tab`);
  const ctx = getActiveCellContext(view);
  if (!ctx) return false;
  const { from, row, col, rowCount, colCount } = ctx;
  let nRow = row ?? -1;
  let nCol = col + 1;
  if (nCol >= colCount) {
    nCol = 0;
    nRow += 1;
  }
  if (nRow >= rowCount) {
    console.log(`${logPrefix} keymap: Tab (End of table)`);
    return false; 
  }
  focusCell(view, from, nRow < 0 ? null : nRow, nCol);
  return true;
}
function cmdShiftTab(view: EditorView): boolean {
  // (中略: v13 から変更なし)
  console.log(`${logPrefix} keymap: Shift-Tab`);
  const ctx = getActiveCellContext(view);
  if (!ctx) return false;
  const { from, row, col, rowCount, colCount } = ctx;
  let nRow = row ?? -1;
  let nCol = col - 1;
  if (nCol < 0) {
    nCol = colCount - 1;
    nRow -= 1;
  }
  if (nRow < -1) {
    console.log(`${logPrefix} keymap: Shift-Tab (Start of table)`);
    return false; 
  }
  focusCell(view, from, nRow < 0 ? null : nRow, nCol);
  return true;
}
function moveHorizontal(dir: 'left' | 'right') {
  // (中略: v13 から変更なし)
  return (view: EditorView): boolean => {
    console.log(`${logPrefix} keymap: Arrow ${dir}`);
    const ctx = getActiveCellContext(view);
    if (!ctx) return false;
    const { from, row, col, colCount } = ctx;
    const nCol = clamp(col + (dir === 'left' ? -1 : 1), 0, colCount - 1);
    if (nCol === col) {
      console.log(`${logPrefix} keymap: Arrow ${dir} (At edge)`);
      return false; 
    }
    focusCell(view, from, row, nCol);
    return true;
  };
}
function moveVertical(dir: 'up' | 'down') {
  // (中略: v13 から変更なし)
  return (view: EditorView): boolean => {
    console.log(`${logPrefix} keymap: Arrow ${dir}`);
    const ctx = getActiveCellContext(view);
    if (!ctx) return false;
    const { from, row, col, rowCount } = ctx;
    let nRow: number | null = row ?? -1; // -1 = header
    if (dir === 'up') {
      if (nRow === 0) nRow = null; 
      else if (nRow > 0) nRow = nRow - 1; 
      else {
        console.log(`${logPrefix} keymap: Arrow ${dir} (At edge)`);
        return false; 
      }
    } else {
      if (nRow === null) nRow = 0; 
      else if (nRow < rowCount - 1) nRow = nRow + 1; 
      else {
        console.log(`${logPrefix} keymap: Arrow ${dir} (At edge)`);
        return false; 
      }
    }
    focusCell(view, from, nRow, col);
    return true;
  };
}
function copySelectionTSV(view: EditorView): boolean {
  console.log(`${logPrefix} keymap: Mod-c (Not implemented)`);
  return false;
}

// (v13 の tableKeymap: タイポ修正済み)
export const tableKeymap = keymap.of([
  { key: 'ArrowLeft', run: moveHorizontal('left') },
  { key: 'ArrowRight', run: moveHorizontal('right') },
  { key: 'ArrowUp', run: moveVertical('up') },
  { key: 'ArrowDown', run: moveVertical('down') },
  { key: 'Enter', run: cmdEnter },
  { key: 'Tab', run: cmdTab },
  { key: 'Shift-Tab', run: cmdShiftTab }, 
  { key: 'Mod-c', run: copySelectionTSV },
]);

export const tableExtension = [
  tableDecoField,
];