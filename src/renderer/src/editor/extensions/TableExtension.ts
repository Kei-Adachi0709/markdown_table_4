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
  Prec
} from '@codemirror/state';

// ... (interface TableBlock やヘルパー関数は変更なし) ...
// ... (parseTablesInDoc, getTableWidgetContainer, getCellRC, clamp は変更なし) ...

// ---- Widget ----
class TableWidget extends WidgetType {
  constructor(private block: TableBlock) {
    super();
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof TableWidget)) return false;
    // ... (eq の中身は変更なし) ...
    return true;
  }

  ignoreEvent(event: Event): boolean {
    // key イベントはエディタに流す（keymap を効かせる）
    if (event.type === 'keydown' || event.type === 'keyup') return false;
    return true;
  }

  // ★★★ここから下を修正 (メソッドをアロー関数形式 = に変更)★★★

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
      tryFocus();
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
    // ... (menu.style 設定は変更なし) ...

    const mkItem = (label: string, cb: () => void, enabled = true) => {
      // ... (mkItem の中身は変更なし) ...
      return it;
    };

    // ... (closeOnOutside は変更なし) ...

    const rowOpsEnabled = rc.row != null;
    const colOpsEnabled = true;

    // Row ops (this.insertRow などがアロー関数になったので 'this' が束縛される)
    menu.appendChild(mkItem('上に行を挿入', () => this.insertRow(view, container, rc.col, rc.row!, 'above'), rowOpsEnabled));
    menu.appendChild(mkItem('下に行を挿入', () => this.insertRow(view, container, rc.col, rc.row!, 'below'), rowOpsEnabled));
    menu.appendChild(mkItem('行を削除', () => this.deleteRow(view, container, rc.row!), rowOpsEnabled));

    // ... (sep は変更なし) ...

    // Col ops (this.insertCol などがアロー関数になったので 'this' が束縛される)
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
    // ... (el の設定は変更なし) ...

    const extractValue = () => (el.textContent ?? '').replace(/\r?\n/g, ' ');
    const commit = () => updateValue(extractValue());

    el.addEventListener('input', () => commit());
    el.addEventListener('blur', () => commit());
    
    // ★★★ keydown リスナーを修正 ★★★
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

    // 矩形選択 (アロー関数なので 'this' はOK)
    el.addEventListener('mousedown', (e) => {
      // ... (中身は変更なし) ...
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
    // ... (container の設定は変更なし) ...

    const table = document.createElement('table');
    // ... (table の設定は変更なし) ...

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');

    // ... (colCount, container.dataset は変更なし) ...

    const headers = Array.from({ length: colCount }, (_, i) => this.block.headers[i] ?? '');
    const aligns = Array.from({ length: colCount }, (_, i) => this.block.aligns[i] ?? null);

    headers.forEach((text, col) => {
      // 'this.buildCell' を呼ぶ (this は toDOM の this = TableWidget)
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

    // ... (styleSel, table.appendChild, return container は変更なし) ...
    return container;
  }
} // ★★★ クラス定義はここまで ★★★

// ... (buildDecorations, tableDecoField は変更なし) ...
// ... (getActiveCellContext, focusCell, cmdTab, cmdShiftTab は変更なし) ...

// ★ cmdEnter が `block` を最新の state から取得するように修正
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
    focusCell(view, from, rowCount, col);
    return true;
  } else {
    focusCell(view, from, nRow, col);
    return true;
  }
}

// ... (moveHorizontal, moveVertical, copySelectionTSV は変更なし) ...
// ... (tableKeymap, tableExtension は変更なし) ...