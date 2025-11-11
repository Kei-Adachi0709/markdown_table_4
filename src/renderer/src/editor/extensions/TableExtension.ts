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

// ---- Types and Helpers ----

type Align = 'left' | 'right' | 'center' | null;

interface TableBlock {
  from: number;
  to: number;
  headers: string[];
  aligns: Align[];
  rows: string[][];
}

// テーブルを Markdown テキストに戻す
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

// ドキュメント全体をパースしてテーブルブロックの配列を返す
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

      let stateLoop: 'header' | 'align' | 'row' = 'header';

      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        const lineText = state.doc.sliceString(child.from, child.to); // v5 修正済み

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
  return blocks;
}

// DOM 要素からウィジェットコンテナを探す
function getTableWidgetContainer(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.closest<HTMLElement>('.cm-md-table-widget');
}

// DOM 要素 (th/td) から (row, col) を取得
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
  // ★★★ 修正 (v7): ウィジェットの DOM を保持
  private container: HTMLElement | null = null;
  
  constructor(private block: TableBlock) {
    super();
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof TableWidget)) return false;
    if (other.block.from !== this.block.from ||
        other.block.to !== this.block.to ||
        other.block.headers.join('|') !== this.block.headers.join('|') ||
        other.block.rows.map(r => r.join('|')).join('||') !== this.block.rows.map(r => r.join('|')).join('||')
    ) return false;
    return true;
  }

  ignoreEvent(event: Event): boolean {
    if (event.type === 'keydown' || event.type === 'keyup') return false;
    return true;
  }

  // ★★★ 修正 (v7): dispatchReplace を全面的に書き換え ★★★
  private dispatchReplace = (view: EditorView, updated: TableBlock, after?: () => void) => {
    // ★ 1. dispatch を非同期にし、「Update Error」を防ぐ
    setTimeout(() => {
      if (!this.container) return; // コンテナがない

      // ★ 2. 「RangeError」を防ぐため、古い `this.block` の範囲を信用せず、
      //        DOM (this.container) から現在のウィジェットの *最新の開始位置* を取得
      const currentFrom = view.posAtDOM(this.container); 
      if (currentFrom === null || currentFrom === -1) {
          console.error("TableWidget: 範囲 (from) が見つかりません。");
          return; 
      }

      // ★ 3. 最新の EditorState から、その開始位置に *今ある* ブロックを再パース
      const latestBlock = parseTablesInDoc(view.state).find(b => b.from === currentFrom);
      if (!latestBlock) {
           console.error(`TableWidget: ${currentFrom} に最新のブロックが見つかりません。`);
           return;
      }

      // ★ 4. 「変更内容 (updated)」から新しいテキストを生成
      //    （from/to は念のため最新のものをセット）
      const newText = serializeTable({ ...updated, from: latestBlock.from, to: latestBlock.to });
      
      // ★ 5. *最新の* `from` と `to` を使ってトランザクションを作成
      const tr: TransactionSpec = {
        changes: { from: latestBlock.from, to: latestBlock.to, insert: newText }
      };
      
      // ★ 6. dispatch を実行
      view.dispatch(tr);
      
      if (after) {
          // dispatch が完了した後に実行 (focusCellAt など)
          after();
      }
    }, 0); // dispatch 全体を非同期化
  }

  private focusCellAt = (view: EditorView, from: number, row: number | null, col: number) => {
    try {
      const tryFocus = () => {
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
        if (target && target.firstChild instanceof Text) {
          const s = window.getSelection();
          const r = document.createRange();
          r.selectNodeContents(target);
          r.collapse(false);
          s?.removeAllRanges();
          s?.addRange(r);
        }
      };
      setTimeout(tryFocus, 0); // v6 から非同期
    } catch {
      /* noop */
    }
  }

  private getBlockAtFrom = (state: EditorState, from: number): TableBlock | null => {
    const blocks = parseTablesInDoc(state);
    return blocks.find(b => b.from === from) ?? null;
  }

  // ---- Row/Col ops ----
  private insertRow = (view: EditorView, container: HTMLElement, col: number, row: number, where: 'above' | 'below') => {
    const from = parseInt(container.dataset.from!, 10);
    // ★ getBlockAtFrom で *最新の* state から block を取得 (これは v6 でも正しかった)
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
    const colCount = Math.max(block.headers.length, ...block.rows.map(r => r.length));
    const at = where === 'above' ? row : row + 1;
    const newRows = block.rows.slice();
    newRows.splice(at, 0, Array(colCount).fill(''));
    const updated: TableBlock = { ...block, rows: newRows };
    
    // ★ 修正 (v7): dispatchReplace が動的に from/to を計算する
    //    after (フォーカス処理) の from は、*変更後の* from (currentFrom) を使う必要があるが、
    //    dispatchReplace が非同期のため、ここではまだ分からない。
    //    -> focusCellAt の `from` (data-attr) は古いまま (this.block.from) を使う
    this.dispatchReplace(view, updated, () => this.focusCellAt(view, from, at, col));
  }

  private deleteRow = (view: EditorView, container: HTMLElement, row: number) => {
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
    if (block.rows.length === 0) return;
    const newRows = block.rows.slice();
    const focusRow = Math.max(0, Math.min(row, newRows.length - 2));
    newRows.splice(row, 1);
    const updated: TableBlock = { ...block, rows: newRows };
    this.dispatchReplace(view, updated, () => this.focusCellAt(view, from, focusRow, 0));
  }

  private insertCol = (view: EditorView, container: HTMLElement, col: number, where: 'left' | 'right') => {
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
    this.dispatchReplace(view, updated, () => this.focusCellAt(view, from, 0, at));
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
    this.dispatchReplace(view, updated, () => this.focusCellAt(view, from, 0, newCol));
  }

  private showContextMenu = (view: EditorView, container: HTMLElement, rc: { row: number | null; col: number }, x: number, y: number) => {
    container.querySelectorAll('.cm-table-menu').forEach((m) => m.remove());

    const menu = document.createElement('div');
    menu.className = 'cm-table-menu';
    // (中略: メニューのスタイルは変更なし)
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

    // (中略: メニュー項目の追加は変更なし)
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

  private buildCell = (
    tag: 'th' | 'td',
    text: string,
    col: number,
    row: number | null,
    al: Align,
    updateValue: (val: string) => void,
    view: EditorView
  ) => {
    const el = document.createElement(tag);
    el.contentEditable = 'true';
    el.textContent = text;
    // (中略: スタイルは変更なし)
    el.style.minWidth = '50px';
    el.style.textAlign = al ?? 'left';
    el.style.padding = '4px 8px';
    el.style.border = '1px solid #ccc';
    el.style.position = 'relative'; 
    el.style.outline = 'none';

    el.addEventListener('focus', () => {
      el.style.boxShadow = 'inset 0 0 0 2px #007bff';
    });
    
    const extractValue = () => (el.textContent ?? '').replace(/\r?\n/g, ' ');
    const commit = () => updateValue(extractValue());
    
    el.addEventListener('blur', () => {
      el.style.boxShadow = 'none';
      commit(); // ★ blur 時にコミット。v7 の dispatchReplace で非同期化された
    });

    el.addEventListener('input', () => {
      // noop
    });
    
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); 
        commit(); 
        (el as HTMLElement).blur(); // キーマップ (cmdEnter) を起動
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab'].includes(e.key)) {
          commit();
      }
    });

    el.addEventListener('mousedown', (e) => {
      // noop
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const container = getTableWidgetContainer(el);
      if (!container) return;
      const rc = getCellRC(el);
      if (!rc) return;
      this.showContextMenu(view, container, rc, e.clientX, e.clientY);
    });

    return el;
  }

  // ★ toDOM はアロー関数 ( = ) に *しない*
  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    // ★★★ 修正 (v7): コンテナをインスタンスに保存
    this.container = container;
    
    container.className = 'cm-md-table-widget';
    // (中略: スタイルは変更なし)
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
        // ★ getBlockAtFrom で最新の block を取得
        const currentBlock = this.getBlockAtFrom(view.state, this.block.from) ?? this.block;
        const updated: TableBlock = {
          ...currentBlock, // ★ this.block -> currentBlock
          headers: headers.map((h, i) => (i === col ? val : h)),
          aligns
        };
        // ★ v7 の dispatchReplace を呼ぶ
        this.dispatchReplace(view, updated, () => this.focusCellAt(view, this.block.from, null, col));
      }, view);
      trh.appendChild(th);
    });
    thead.appendChild(trh);

    const tbody = document.createElement('tbody');
    this.block.rows.forEach((row, rIdx) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        const td = this.buildCell('td', row[c] ?? '', c, rIdx, aligns[c] ?? null, (val) => {
          // ★ getBlockAtFrom で最新の block を取得
          const currentBlock = this.getBlockAtFrom(view.state, this.block.from) ?? this.block;
          const newRows = currentBlock.rows.map((r, i) => (i === rIdx ? [...r] : r.slice())); // ★ currentBlock.rows
          if (!newRows[rIdx]) newRows[rIdx] = Array(colCount).fill('');
          newRows[rIdx][c] = val;
          const updated: TableBlock = { ...currentBlock, rows: newRows }; // ★ currentBlock
          // ★ v7 の dispatchReplace を呼ぶ
          this.dispatchReplace(view, updated, () => this.focusCellAt(view, this.block.from, rIdx, c));
        }, view);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    // (中略: styleSel, table.appendChild などは変更なし)
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

function buildDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const blocks = parseTablesInDoc(state); // v5 修正済み

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

export const tableDecoField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state); // v5 修正済み
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildDecorations(tr.state); // v5 修正済み
  },
  provide: (f) => EditorView.decorations.from(f)
});

// ---- Keymap ----

// (中略: getActiveCellContext, focusCell は v6 から変更なし)
function getActiveCellContext(view: EditorView) {
  const sel = view.state.selection.main;
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
  return { ...rc, from, colCount, rowCount, block };
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

// ★★★ 修正 (v7): cmdEnter の dispatch を非同期化 ★★★
function cmdEnter(view: EditorView): boolean {
  const ctx = getActiveCellContext(view);
  if (!ctx) return false;
  
  const currentBlock = parseTablesInDoc(view.state).find(b => b.from === ctx.from);
  if (!currentBlock) return false;

  const { from, row, col, rowCount, colCount } = ctx;
  let curRow = row ?? -1;
  let nRow = curRow + 1;

  if (nRow >= rowCount) {
    // 最終行 → 新規行追加
    const newRow = Array(colCount).fill('');
    const updated: TableBlock = { ...currentBlock, rows: [...currentBlock.rows, newRow] };
    const newText = serializeTable(updated);

    // ★ dispatch を非同期にし、Update Error を防ぐ
    setTimeout(() => {
        // ★ dispatch 時点での *最新の* ブロック範囲を再取得 (RangeError 対策)
        const latestBlock = parseTablesInDoc(view.state).find(b => b.from === currentBlock.from);
        if (!latestBlock) return;
        
        view.dispatch({ changes: { from: latestBlock.from, to: latestBlock.to, insert: newText } });
        
        // ★ dispatch 完了後にフォーカス (focusCell は内部で非同期)
        focusCell(view, from, rowCount, col);
    }, 0);
    
    return true;
  } else {
    // 次の行にフォーカス
    focusCell(view, from, nRow, col);
    return true;
  }
}

// (中略: Tab, Shift+Tab, 矢印キー移動 は v6 から変更なし)
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
  if (nRow >= rowCount) {
    return false; 
  }
  focusCell(view, from, nRow < 0 ? null : nRow, nCol);
  return true;
}
function cmdShiftTab(view: EditorView): boolean {
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
    return false; 
  }
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
    let nRow: number | null = row ?? -1; // -1 = header
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
function copySelectionTSV(view: EditorView): boolean {
  return false;
}

export const tableKeymap = keymap.of([
  { key: 'ArrowLeft', run: moveHorizontal('left') },
  { key: 'ArrowRight', run: moveHorizontal('right') },
  { key: 'ArrowUp', run: moveVertical('up') },
  { key: 'ArrowDown', run: moveVertical('down') },
  { key: 'Enter', run: cmdEnter },
  { key: 'Tab', run: cmdTab },
  { key: 'Shift-Tab', run: cmdShiftTab }, // v6 修正済み
  { key: 'Mod-c', run: copySelectionTSV },
]);

export const tableExtension = [
  tableDecoField,
];