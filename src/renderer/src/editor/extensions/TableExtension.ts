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

  // TODO: セルの内容をエスケープする
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

      let state: 'header' | 'align' | 'row' = 'header';

      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        const lineText = state.sliceDoc(child.from, child.to);

        if (child.name === 'TableHeader') {
          // ヘッダー行
          const parts = lineText.split('|').map(s => s.trim());
          if (parts[0] === '') parts.shift();
          if (parts[parts.length - 1] === '') parts.pop();
          headers.push(...parts);
          state = 'align';
        } else if (child.name === 'TableDelim') {
          // 分割行
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
          state = 'row';
        } else if (child.name === 'TableRow') {
          // データ行
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
  return { row: rowEl.rowIndex - 1, col }; // <tbody> の <tr> は rowIndex が 1 から始まる (thead があれば)
}

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

// ---- Widget ----
class TableWidget extends WidgetType {
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
    // key イベントはエディタに流す（keymap を効かせる）
    if (event.type === 'keydown' || event.type === 'keyup') return false;
    // それ以外の DOM イベント (click, input, contextmenu...) はウィジェット内で処理し、
    // エディタには伝播させない (カーソル移動などを防ぐ)
    return true;
  }

  // ★★★ アロー関数 (=) 形式 ★★★

  private dispatchReplace = (view: EditorView, updated: TableBlock, after?: () => void) => {
    const newText = serializeTable(updated);
    const tr: TransactionSpec = {
      changes: { from: this.block.from, to: this.block.to, insert: newText }
    };
    view.dispatch(tr);
    if (after) {
      after();
    }
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
      // dispatch が同期的でない場合があるので、少し待ってからフォーカス
      setTimeout(tryFocus, 0);
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
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
    const colCount = Math.max(block.headers.length, ...block.rows.map(r => r.length));
    const at = where === 'above' ? row : row + 1;
    const newRows = block.rows.slice();
    newRows.splice(at, 0, Array(colCount).fill(''));
    const updated: TableBlock = { ...block, rows: newRows };
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
    // 少し遅れて登録 (contextmenu イベントが即座に click を発火させないように)
    setTimeout(() => document.addEventListener('click', closeOnOutside), 0);

    const rowOpsEnabled = rc.row != null;
    const colOpsEnabled = true;

    // Row ops
    menu.appendChild(mkItem('上に行を挿入', () => this.insertRow(view, container, rc.col, rc.row!, 'above'), rowOpsEnabled));
    menu.appendChild(mkItem('下に行を挿入', () => this.insertRow(view, container, rc.col, rc.row!, 'below'), rowOpsEnabled));
    menu.appendChild(mkItem('行を削除', () => this.deleteRow(view, container, rc.row!), rowOpsEnabled));

    const sep = document.createElement('div');
    sep.style.height = '1px';
    sep.style.backgroundColor = '#eee';
    sep.style.margin = '4px 0';
    menu.appendChild(sep);

    // Col ops
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
    el.style.minWidth = '50px';
    el.style.textAlign = al ?? 'left';
    el.style.padding = '4px 8px';
    el.style.border = '1px solid #ccc';
    el.style.position = 'relative'; // for selection
    el.style.outline = 'none';

    // セル編集中にカーソルが外れないように
    el.addEventListener('focus', () => {
      el.style.boxShadow = 'inset 0 0 0 2px #007bff';
    });
    el.addEventListener('blur', () => {
      el.style.boxShadow = 'none';
      commit(); // blur 時にコミット
    });

    const extractValue = () => (el.textContent ?? '').replace(/\r?\n/g, ' ');
    const commit = () => updateValue(extractValue());

    el.addEventListener('input', () => {
      // input イベントは即時コミットしない（重すぎるため）
    });
    
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); // デフォルトの Enter (改行) を防ぐ
        commit(); // 現在の内容を保存
        (el as HTMLElement).blur(); // ★フォーカスを外し、キーマップ(cmdEnter)が起動できるようにする
        return;
      }

      // 矢印キーやTabキーが押されたとき、
      // セルの内容をコミット（保存）する
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab'].includes(e.key)) {
          commit();
          // preventDefault はしない (キーマップに任せる)
      }
    });

    el.addEventListener('mousedown', (e) => {
      // mousedown でフォーカスを当てる
    });

    // 右クリックメニュー (アロー関数なので 'this' はOK)
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
      // 'this.buildCell' を呼ぶ
      const th = this.buildCell('th', text, col, null, aligns[col] ?? null, (val) => {
        const updated: TableBlock = {
          ...this.block,
          headers: headers.map((h, i) => (i === col ? val : h)),
          aligns
        };
        // 'this.dispatchReplace' (アロー関数) を呼ぶ
        this.dispatchReplace(view, updated, () => this.focusCellAt(view, this.block.from, null, col));
      }, view);
      trh.appendChild(th);
    });
    thead.appendChild(trh);

    const tbody = document.createElement('tbody');
    this.block.rows.forEach((row, rIdx) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        // 'this.buildCell' を呼ぶ
        const td = this.buildCell('td', row[c] ?? '', c, rIdx, aligns[c] ?? null, (val) => {
          const newRows = this.block.rows.map((r, i) => (i === rIdx ? [...r] : r.slice()));
          if (!newRows[rIdx]) newRows[rIdx] = Array(colCount).fill('');
          newRows[rIdx][c] = val;
          const updated: TableBlock = { ...this.block, rows: newRows };
          // 'this.dispatchReplace' (アロー関数) を呼ぶ
          this.dispatchReplace(view, updated, () => this.focusCellAt(view, this.block.from, rIdx, c));
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

// ★★★ 修正: (view: EditorView) から (state: EditorState) に変更 ★★★
function buildDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // ★★★ 修正: view.state ではなく state を渡す ★★★
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

// ★★★ 修正: 'export' を追加 & 呼び出し方を修正 ★★★
export const tableDecoField = StateField.define<DecorationSet>({
  create(state) {
    // ★★★ 修正: new EditorView(state) ではなく state を渡す ★★★
    return buildDecorations(state);
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    // ★★★ 修正: new EditorView(tr.state) ではなく tr.state を渡す ★★★
    return buildDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f)
});

// ---- Keymap ----

// アクティブなセルのコンテキストを取得 (矢印キー移動用)
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

// 特定のセルにフォーカスを移動
function focusCell(view: EditorView, from: number, row: number | null, col: number) {
  const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`) as HTMLElement | null;
  if (!container) return;

  let target: HTMLElement | null = null;
  if (row == null || row < 0) {
    // header
    target = container.querySelector(`thead tr > :nth-child(${col + 1})`) as HTMLElement | null;
  } else {
    // body
    const tr = container.querySelector(`tbody tr:nth-child(${row + 1})`) as HTMLElement | null;
    if (tr) target = tr.children[col] as HTMLElement | null;
  }
  
  if (target) {
    // ★ 安定化のため setTimeout を追加
    setTimeout(() => {
        target?.focus();
        // カーソルを末尾に
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

// Enter: フォーカスが外れるので、キーマップが拾う
function cmdEnter(view: EditorView): boolean {
  const ctx = getActiveCellContext(view);
  if (!ctx) return false;
  
  // ★ 修正: ctx.block (古い可能性) ではなく、最新の block を取得する
  const currentBlock = parseTablesInDoc(view.state).find(b => b.from === ctx.from);
  if (!currentBlock) return false;

  const { from, row, col, rowCount, colCount } = ctx;
  let curRow = row ?? -1;
  let nRow = curRow + 1;

  if (nRow >= rowCount) {
    // 最終行 → 新規行追加
    const newRow = Array(colCount).fill('');
    const updated: TableBlock = { ...currentBlock, rows: [...currentBlock.rows, newRow] }; // ★ currentBlock を使用
    const newText = serializeTable(updated);
    view.dispatch({ changes: { from: currentBlock.from, to: currentBlock.to, insert: newText } }); // ★ currentBlock を使用
    // ★ 修正: dispatch が完了した後にフォーカス
    setTimeout(() => focusCell(view, from, rowCount, col), 0);
    return true;
  } else {
    // 次の行にフォーカス
    focusCell(view, from, nRow, col);
    return true;
  }
}

// Tab: 次のセル
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
    // TODO: 最終セルならテーブルを抜ける？
    return false; // keymap が false を返すとデフォルトの Tab 動作
  }
  
  focusCell(view, from, nRow < 0 ? null : nRow, nCol);
  return true;
}

// Shift+Tab: 前のセル
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
    return false; // 最初のセル
  }
  
  focusCell(view, from, nRow < 0 ? null : nRow, nCol);
  return true;
}

// 左右移動
function moveHorizontal(dir: 'left' | 'right') {
  return (view: EditorView): boolean => {
    const ctx = getActiveCellContext(view);
    if (!ctx) return false;

    // TODO: カーソル位置が端かチェック
    // 今は即座にセルを移動
    
    const { from, row, col, colCount } = ctx;
    const nCol = clamp(col + (dir === 'left' ? -1 : 1), 0, colCount - 1);
    if (nCol === col) return false; // 端だった
    
    focusCell(view, from, row, nCol);
    return true;
  };
}

// 上下移動
function moveVertical(dir: 'up' | 'down') {
  return (view: EditorView): boolean => {
    const ctx = getActiveCellContext(view);
    if (!ctx) return false;
    
    const { from, row, col, rowCount } = ctx;
    let nRow: number | null = row ?? -1; // -1 = header
    
    if (dir === 'up') {
      if (nRow === 0) nRow = null; // 1行目 -> ヘッダー
      else if (nRow > 0) nRow = nRow - 1; // 2行目以降
      else return false; // ヘッダー (null) より上には行けない
    } else {
      if (nRow === null) nRow = 0; // ヘッダー -> 1行目
      else if (nRow < rowCount - 1) nRow = nRow + 1; // 最終行より前
      else return false; // 最終行
    }
    
    focusCell(view, from, nRow, col);
    return true;
  };
}

// TSV でコピー
function copySelectionTSV(view: EditorView): boolean {
  // TODO: 矩形選択した範囲を TSV でクリップボードにコピー
  return false;
}

// ★★★ 'export' を追加 ★★★
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

// ★★★ tableDecoField のみを含むように変更 ★★★
export const tableExtension = [
  tableDecoField,
];