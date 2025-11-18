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

// (v8) テーブルを Markdown テキストに戻す
function serializeTable(block: TableBlock): string {
  // console.log(`${logPrefix} serializeTable()`);
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

// (v8) ドキュメント全体をパースしてテーブルブロックの配列を返す
function parseTablesInDoc(state: EditorState): TableBlock[] {
  // ★ (v23) ログ復活
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
        // (v5 修正) state.sliceDoc -> state.doc.sliceString
        const lineText = state.doc.sliceString(child.from, child.to); 

        if (child.name === 'TableHeader') {
          // ヘッダー行
          const parts = lineText.split('|').map(s => s.trim());
          if (parts[0] === '') parts.shift();
          if (parts[parts.length - 1] === '') parts.pop();
          headers.push(...parts);
          stateLoop = 'align';
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
          stateLoop = 'row';
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
  // ★ (v23) ログ復活
  console.log(`${logPrefix} parseTablesInDoc: ${blocks.length} tables found.`);
  return blocks;
}

// (v8) DOM 要素からウィジェットコンテナを探す
function getTableWidgetContainer(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  return el.closest<HTMLElement>('.cm-md-table-widget');
}

// (v8) DOM 要素 (th/td) から (row, col) を取得
function getCellRC(el: HTMLElement | null): { row: number | null; col: number } | null {
  if (!el || (el.tagName !== 'TH' && el.tagName !== 'TD')) return null;
  const col = el.cellIndex;
  const rowEl = el.closest('tr');
  if (!rowEl) return null;
  const head = rowEl.closest('thead');
  if (head) return { row: null, col };
  // (v19) <tbody> がない場合 (toDOM が thead の次に行を追加した場合) も考慮
  const tbody = rowEl.closest('tbody');
  if (tbody) {
      return { row: rowEl.rowIndex - 1, col }; // <tbody> の <tr> は rowIndex が 1 から始まる (thead があれば)
  }
  // (v19) thead の直後の tr の場合 (tbody がない)
  if (rowEl.parentElement?.tagName === 'TABLE') {
      const theadRowCount = rowEl.parentElement.querySelector('thead')?.rows.length ?? 0;
      return { row: rowEl.rowIndex - theadRowCount, col };
  }
  return { row: rowEl.rowIndex, col }; // フォールバック
}

// (v8)
function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

// ---- Widget ----
class TableWidget extends WidgetType {
  private container: HTMLElement | null = null;
  // (v14) 右クリックメニューフラグ
  private isOpeningContextMenu = false;
  // (v16) プログラムによるフォーカス移動中フラグ
  private isProgrammaticFocus = false;

  // ★ (v20) リサイズ中の列の <col> 要素
  private resizingCol: HTMLTableColElement | null = null;
  // ★ (v20) リサイズ開始時のマウスX座標
  private resizeStartX = 0;
  // ★ (v20) リサイズ開始時の列幅
  private resizeStartWidth = 0;
  // ★ (v20) document にバインドされたリスナー（解除用）
  private resizeMouseMoveListener = (e: MouseEvent) => this.handleResizeMouseMove(e);
  private resizeMouseUpListener = (e: MouseEvent) => this.handleResizeMouseUp(e);
  
  constructor(private block: TableBlock) {
    super();
    console.log(`${logPrefix} new TableWidget() [from: ${block.from}, to: ${block.to}]`);
  }

  // (v8)
  eq(other: WidgetType): boolean {
    const eq = (o: TableWidget) => {
       if (o.block.from !== this.block.from ||
           o.block.to !== this.block.to ||
           o.block.headers.join('|') !== this.block.headers.join('|') ||
           o.block.rows.map(r => r.join('|')).join('||') !== this.block.rows.map(r => r.join('|')).join('||')
       ) return false;
       return true;
    }
    const result = (other instanceof TableWidget) && eq(other);
    // console.log(`${logPrefix} eq(): ${result}`);
    return result;
  }

  // (v8)
  ignoreEvent(event: Event): boolean {
    // key イベントはエディタに流す（keymap を効かせる）
    // それ以外の DOM イベント (click, input, contextmenu...) はウィジェット内で処理
    const ignored = event.type !== 'keydown' && event.type !== 'keyup';
    // // console.log(`${logPrefix} ignoreEvent(${event.type}): ${ignored}`); // ログが多すぎるため v18 でコメントアウト
    return ignored;
  }

  // (v8 の dispatchReplace: RangeError 対策済み)
  private dispatchReplace = (view: EditorView, updated: TableBlock, after?: (latestFrom?: number) => void) => {
    console.log(`${logPrefix} dispatchReplace() CALLED`);
    
    // (v8) 非同期にして update 中の dispatch を防ぐ
    setTimeout(() => {
      // (v8) 古い this.block.from をキーに、最新の view.state から最新のブロック範囲を取得
      const initialFrom = this.block.from;
      console.log(`${logPrefix} dispatchReplace(async): Searching block at initialFrom: ${initialFrom}`);
      
      const latestBlock = parseTablesInDoc(view.state).find(b => b.from === initialFrom);
      
      // (v8) ブロックが見つからない (e.g. 削除された) 場合は何もしない
      if (!latestBlock) {
           console.error(`${logPrefix} dispatchReplace(async): Block not found at ${initialFrom}!`);
           return;
      }
      
      console.log(`${logPrefix} dispatchReplace(async): Block found [from: ${latestBlock.from}, to: ${latestBlock.to}]`);
      // (v8) 最新のブロック情報を使って Markdown テキストを生成
      const newText = serializeTable({ ...updated, from: latestBlock.from, to: latestBlock.to });
      
      // (v8) 最新の from/to を使って変更トランザクションを作成
      const tr: TransactionSpec = {
        changes: { from: latestBlock.from, to: latestBlock.to, insert: newText }
      };
      
      console.log(`${logPrefix} dispatchReplace(async): DISPATCHING...`);
      view.dispatch(tr);
      console.log(`${logPrefix} dispatchReplace(async): DISPATCHED`);
      
      if (after) {
          console.log(`${logPrefix} dispatchReplace(async): Calling 'after' callback...`);
          // (v8) after にも最新の from を渡す
          after(latestBlock.from);
      }
    }, 0); 
  }

  // (v16 の focusCellAt)
  public focusCellAt = (view: EditorView, from: number, row: number | null, col: number) => { // ★ (v18) public に変更
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
          // header
          target = container.querySelector(`thead tr > :nth-child(${col + 1})`) as HTMLElement | null;
        } else {
          // body
          const tr = container.querySelector(`tbody tr:nth-child(${row + 1})`) as HTMLElement | null;
          if (tr) target = tr.children[col] as HTMLElement | null;
        }
        
        if (target) {
          console.log(`${logPrefix} focusCellAt(async): Target found, setting flag and calling .focus()`);
          
          // ★ (v16) これから .focus() を呼ぶことをフラグで伝える
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
        } else {
          console.warn(`${logPrefix} focusCellAt(async): Target cell (row: ${row}, col: ${col}) not found.`);
        }
      };
      // (v8) dispatch が非同期なので、フォーカスも非同期（DOM 更新後）
      setTimeout(tryFocus, 0);
    } catch (e) {
      console.error(`${logPrefix} focusCellAt: Error`, e);
    }
  }

  // (v8 の getBlockAtFrom)
  private getBlockAtFrom = (state: EditorState, from: number): TableBlock | null => {
    // console.log(`${logPrefix} getBlockAtFrom(from: ${from})`);
    const blocks = parseTablesInDoc(state);
    const block = blocks.find(b => b.from === from) ?? null;
    if (!block) console.warn(`${logPrefix} getBlockAtFrom: Block not found at ${from}`);
    return block;
  }

  // ---- Row/Col ops ----
  // (v15 の Row/Col 操作)
  private insertRow = (view: EditorView, container: HTMLElement, col: number, row: number, where: 'above' | 'below') => {
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
  // ★ (v15) row を引数で受け取る
  private insertCol = (view: EditorView, container: HTMLElement, col: number, row: number | null, where: 'left' | 'right') => {
    console.log(`${logPrefix} insertCol(col: ${col}, row: ${row}, where: ${where})`);
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
    // ★ (v15) 0 (ヘッダー) ではなく、引数の row にフォーカスを戻す
    this.dispatchReplace(view, updated, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, row, at));
  }
  private deleteCol = (view: EditorView, container: HTMLElement, col: number) => {
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

  // (v14 の showContextMenu)
  private showContextMenu = (view: EditorView, container: HTMLElement, rc: { row: number | null; col: number }, x: number, y: number) => {
    console.log(`${logPrefix} showContextMenu(row: ${rc.row}, col: ${rc.col})`);
    // 古いメニューを削除
    container.querySelectorAll('.cm-table-menu').forEach((m) => m.remove());

    const menu = document.createElement('div');
    menu.className = 'cm-table-menu';
    // (スタイル設定 ... 省略)
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
        // (v14) フラグのリセットは mousedown / blur が行う
        // this.isOpeningContextMenu = false; 
        document.removeEventListener('click', closeOnOutside);
      }
    };
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

    // Col ops (★ v15: rc.row を insertCol に渡す)
    menu.appendChild(mkItem('左に列を挿入', () => this.insertCol(view, container, rc.col, rc.row, 'left'), colOpsEnabled));
    menu.appendChild(mkItem('右に列を挿入', () => this.insertCol(view, container, rc.col, rc.row, 'right'), colOpsEnabled));
    menu.appendChild(mkItem('列を削除', () => this.deleteCol(view, container, rc.col), colOpsEnabled));

    document.body.appendChild(menu);
  }

  // ★ (v20) リサイズロジック
  // ★★★ (v22) 修正: colIndex を引数で受け取る
  private handleResizeMousedown = (e: MouseEvent, colEl: HTMLTableColElement, colIndex: number) => {
    // ★ (v21) ログ復活
    // const colIndex = Array.from(colEl.parentElement?.children ?? []).indexOf(colEl); // ★ (v22) 削除 (バグの原因)
    console.log(`${logPrefix} [RESIZE] mousedown (col: ${colIndex})`);
    
    e.preventDefault();
    e.stopPropagation();

    this.resizingCol = colEl;
    this.resizeStartX = e.clientX;
    this.resizeStartWidth = colEl.offsetWidth; // 現在の幅を取得

    // (v20) リサイズ中はテキスト選択無効（styles.css も参照）
    document.body.classList.add('cm-table-resizing');
    document.addEventListener('mousemove', this.resizeMouseMoveListener);
    document.addEventListener('mouseup', this.resizeMouseUpListener);
  }

  private handleResizeMouseMove = (e: MouseEvent) => {
    if (!this.resizingCol) return;

    e.preventDefault();
    e.stopPropagation();
    
    const diffX = e.clientX - this.resizeStartX;
    const newWidth = Math.max(50, this.resizeStartWidth + diffX); // 最小幅 50px

    // ★ (v21) ログ復活
    // console.log(`${logPrefix} [RESIZE] mousemove (newWidth: ${newWidth}px)`);

    // (v20) <col> の幅を直接変更
    this.resizingCol.style.width = `${newWidth}px`;

    // (v20) table-layout: fixed を強制
    if (this.container) {
        const table = this.container.querySelector('table');
        if (table && table.style.tableLayout !== 'fixed') {
             console.log(`${logPrefix} [RESIZE] mousemove: Setting table-layout: fixed`);
             table.style.tableLayout = 'fixed';
        }
    }
  }

  private handleResizeMouseUp = (e: MouseEvent) => {
    // ★ (v21) ログ復活
    console.log(`${logPrefix} [RESIZE] mouseup`);
    e.preventDefault();
    e.stopPropagation();

    this.resizingCol = null;
    document.body.classList.remove('cm-table-resizing');
    document.removeEventListener('mousemove', this.resizeMouseMoveListener);
    document.removeEventListener('mouseup', this.resizeMouseUpListener);

    // TODO: ここで this.colWidths[col] = newWidth のように永続化できるが、
    // eq() が false になり再描画されると <col> がリセットされるため、
    // 今回はウィジェットの内部状態 (colWidths) には保存しない（＝再描画でリセットされる）
  }

  // ★★★ 修正 (v20): `buildCell` (リサイズハンドルの追加) ★★★
  private buildCell = (
    tag: 'th' | 'td',
    text: string,
    col: number,
    row: number | null,
    al: Align,
    updateValue: (val: string) => void,
    view: EditorView,
    // ★ (v20) <col> 要素をリサイズ用に受け取る
    colEl: HTMLTableColElement | null 
  ) => {
    // ★ (v21) ログ復活
    console.log(`${logPrefix} buildCell(tag: ${tag}, row: ${row}, col: ${col})`);
    
    const el = document.createElement(tag);
    el.contentEditable = 'true';
    el.textContent = text;
    // (スタイル設定 ... 省略)
    el.style.minWidth = '50px';
    el.style.textAlign = al ?? 'left';
    el.style.padding = '4px 8px';
    el.style.border = '1px solid #ccc';
    el.style.position = 'relative'; // ★ resizer のために relative
    el.style.outline = 'none';

    // ★ (v20) ヘッダーセル (th) かつ <col> が渡された場合のみリサイズハンドルを追加
    if (tag === 'th' && colEl) {
      const resizer = document.createElement('div');
      resizer.className = 'cm-table-resizer';
      // (スタイルは styles.css で定義)
      
      // (v20) mousedown でリサイズ開始
      // ★★★ (v22) 修正: `col` を handleResizeMousedown に渡す
      resizer.addEventListener('mousedown', (e) => {
        this.handleResizeMousedown(e, colEl, col); // 'col' は buildCell の引数
      });
      el.appendChild(resizer);
    }

    // ★ (v16) focus リスナー: プログラムフォーカスフラグをリセット
    el.addEventListener('focus', () => {
      // ★ (v21) ログ復活
      console.log(`${logPrefix} FOCUS (row: ${row}, col: ${col})`);
      el.style.boxShadow = 'inset 0 0 0 2px #007bff';
      
      // ★ (v16) フォーカスを受け取ったので、フラグをリセット
      this.isProgrammaticFocus = false;
    });
    
    // ★★★ (v22) 修正: text が変更された場合のみ commit する
    const originalText = text; // (v22) 元のテキストを保存
    const extractValue = () => (el.textContent ?? '').replace(/\r?\n/g, ' ');
    const commit = () => {
      // (v22) 値が変更されたかチェック
      const newValue = extractValue();
      if (newValue === originalText) {
        console.log(`${logPrefix} commit() SKIPPED (row: ${row}, col: ${col}): Value did not change.`);
        return;
      }
      
      console.log(`${logPrefix} commit() CALLED (row: ${row}, col: ${col})`);
      updateValue(newValue);
    }
    
    // ★ (v16) blur リスナー: isProgrammaticFocus をチェック
    el.addEventListener('blur', (e: FocusEvent) => {
      el.style.boxShadow = 'none';

      // ★ (v16) もし `focusCellAt` が（直前に）発火していたら、
      //    この blur はその結果なので、コミットをスキップする
      if (this.isProgrammaticFocus) {
        console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Skipped commit (blur was programmatic)`);
        // (v16) フラグは focus リスナーがリセットする
        return; 
      }

      // (v14) もし `contextmenu` が *直前* に発火していたら、
      //    この blur はメニューを開くためのものなので、コミットをスキップする
      if (this.isOpeningContextMenu) {
        console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Skipped commit (blur was from context menu)`);
        // (v14) フラグをここでリセット
        this.isOpeningContextMenu = false; 
        return; 
      }
      
      // (v10) フォーカスがテーブル内の別のセルに移動したかチェック
      const relatedTarget = e.relatedTarget as HTMLElement | null;
      const container = this.container; 

      if (container && relatedTarget && container.contains(relatedTarget)) {
        console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Skipped commit (focus moved to another cell)`);
        return; 
      }
      
      // (v11) セルが DOM から切り離されていたらコミットしない
      if (!el.isConnected) {
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
    
    // ★★★ (v25) 修正: keydown リスナー (編集キーの伝播を停止) ★★★
    el.addEventListener('keydown', (e) => {
      
      // 1. Keys handled by tableKeymap (Arrows, Tab, PgUp/Dn, Mod-c)
      // We must let these propagate to CodeMirror
      const isNavKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'PageUp', 'PageDown'].includes(e.key);
      const isCopy = (e.metaKey || e.ctrlKey) && e.key === 'c';

      if (isNavKey || isCopy) {
        console.log(`${logPrefix} KEYDOWN (row: ${row}, col: ${col}): ${e.key} (Passing to tableKeymap)`);
        return; // ★ Let event propagate
      }

      // 2. Enter key (handled here)
      if (e.key === 'Enter') {
        e.preventDefault(); // ★ Prevent default (newline)
        e.stopPropagation(); // ★ Stop propagation
        console.log(`${logPrefix} KEYDOWN: Enter. Handling move/add row...`);

        const container = getTableWidgetContainer(el);
        if (!container) return;
        
        const from = parseInt(container.dataset.from!, 10);
        const rowCount = parseInt(container.dataset.rowCount!, 10);
        const colCount = parseInt(container.dataset.colCount!, 10);
        
        const rc = getCellRC(el); 
        if (!rc) return;

        const currentRow = rc.row;
        const currentCol = rc.col;

        // ★ (v23) Commit current cell *before* moving
        commit();

        // ★ (v23) Fix 1: Enter on header (currentRow == null) moves to row 0
        if (currentRow == null) {
            console.log(`${logPrefix} KEYDOWN: Enter (Header) -> Move to row 0`);
            this.focusCellAt(view, from, 0, currentCol);
            return;
        }

        // (v19) Existing logic for data rows
        if (currentRow < rowCount - 1) {
            // ★ Not last row -> move to next row
            const nextRow = currentRow + 1;
            console.log(`${logPrefix} KEYDOWN: Enter (Data Row) -> Move to next row (${nextRow}, ${currentCol})`);
            this.focusCellAt(view, from, nextRow, currentCol);
        } else {
            // ★ Last row -> add new row
            console.log(`${logPrefix} KEYDOWN: Enter (End of table) -> Add row`);
            const block = this.getBlockAtFrom(view.state, from) ?? this.block;
            const newRow = Array(colCount).fill('');
            const updated: TableBlock = { ...block, rows: [...block.rows, newRow] };
            
            this.dispatchReplace(view, updated, (latestFrom) => {
                const newRowIndex = rowCount; 
                console.log(`${logPrefix} KEYDOWN: Enter (Add row) -> Focusing new row (${newRowIndex}, ${currentCol})`);
                this.focusCellAt(view, latestFrom ?? from, newRowIndex, currentCol);
            });
        }
        return;
      }
      
      // 3. ALL OTHER KEYS (Backspace, Delete, letters, Mod-v, Mod-x, etc.)
      // Handled by contentEditable. Stop propagation to prevent CM handling.
      console.log(`${logPrefix} KEYDOWN (row: ${row}, col: ${col}): ${e.key} (Handling as contentEditable input, STOPPING propagation)`);
      e.stopPropagation(); // ★★★ STOP PROPAGATION
    });

    // (v14 の mousedown リスナー)
    el.addEventListener('mousedown', (e) => {
      // console.log(`${logPrefix} mousedown (row: ${row}, col: ${col})`);
      // (v14) 左クリックは必ずメニューフラグをリセットする
      this.isOpeningContextMenu = false;
    });

    // (v14 の contextmenu リスナー)
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      console.log(`${logPrefix} contextmenu (row: ${row}, col: ${col})`);
      
      // (v14) これから `blur` が発生することをフラグで伝える
      this.isOpeningContextMenu = true;
      
      const container = getTableWidgetContainer(el);
      if (!container) return;
      const rc = getCellRC(el);
      if (!rc) return;
      this.showContextMenu(view, container, rc, e.clientX, e.clientY);
    });

    return el;
  }

  // ★ toDOM はアロー関数 ( = ) に *しない*
  // ★★★ 修正 (v20): `toDOM` (<colgroup> の追加) ★★★
  toDOM(view: EditorView): HTMLElement {
    console.log(`${logPrefix} toDOM() [from: ${this.block.from}]`);
    const container = document.createElement('div');
    // (v7) コンテナをインスタンスに保存
    this.container = container; 
    
    container.className = 'cm-md-table-widget';
    // (スタイル設定 ... 省略)
    container.style.padding = '4px';
    container.style.border = '1px dashed #ddd';
    container.style.borderRadius = '4px';
    container.style.margin = '1em 0';

    const table = document.createElement('table');
    table.style.borderCollapse = 'collapse';
    table.style.width = '100%';
    // ★ (v20) リサイズのために table-layout: auto (初期) にしておく
    // (リサイズ開始時に 'fixed' に変更される)
    table.style.tableLayout = 'auto';


    const colCount = Math.max(
      this.block.headers.length,
      this.block.aligns.length,
      ...this.block.rows.map(r => r.length)
    );
    container.dataset.from = this.block.from.toString();
    container.dataset.colCount = colCount.toString();
    container.dataset.rowCount = this.block.rows.length.toString();

    // ★ (v20) <colgroup> を生成
    const colgroup = document.createElement('colgroup');
    const colEls: HTMLTableColElement[] = [];
    for (let i = 0; i < colCount; i++) {
        const colEl = document.createElement('col');
        // (v20) 現状は幅を永続化していないので、ここでは幅を指定しない
        // (auto layout に任せる)
        // colEl.style.width = `${100 / colCount}%`; 
        colgroup.appendChild(colEl);
        colEls.push(colEl);
    }
    table.appendChild(colgroup);

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    trh.style.backgroundColor = '#f8f8f8';

    const headers = Array.from({ length: colCount }, (_, i) => this.block.headers[i] ?? '');
    const aligns = Array.from({ length: colCount }, (_, i) => this.block.aligns[i] ?? null);

    // (v8) ヘッダーセルの構築
    headers.forEach((text, col) => {
      // ★ (v20) 対応する <col> を buildCell に渡す
      const th = this.buildCell('th', text, col, null, aligns[col] ?? null, (val) => {
        // (v8) commit (updateValue) 時に最新の block を取得
        console.log(`${logPrefix} updateValue (Header col: ${col}): '${val}'`);
        const currentBlock = this.getBlockAtFrom(view.state, this.block.from) ?? this.block;
        const updated: TableBlock = {
          ...currentBlock,
          headers: headers.map((h, i) => (i === col ? val : h)),
          aligns
        };
        // (v8) dispatchReplace に (latestFrom) => ... を渡す
        this.dispatchReplace(view, updated, (latestFrom) => this.focusCellAt(view, latestFrom ?? this.block.from, null, col));
      }, view, colEls[col] ?? null); // ★ (v20)
      trh.appendChild(th);
    });
    thead.appendChild(trh);

    // (v8) ボディセルの構築
    const tbody = document.createElement('tbody');
    this.block.rows.forEach((row, rIdx) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        // ★ (v20) <td> にはリサイズハンドル不要なので null を渡す
        const td = this.buildCell('td', row[c] ?? '', c, rIdx, aligns[c] ?? null, (val) => {
          // (v8) commit (updateValue) 時に最新の block を取得
          console.log(`${logPrefix} updateValue (Body row: ${rIdx}, col: ${c}): '${val}'`);
          const currentBlock = this.getBlockAtFrom(view.state, this.block.from) ?? this.block;
          
          const newRows = currentBlock.rows.map((r, i) => (i === rIdx ? [...r] : r.slice()));
          if (!newRows[rIdx]) newRows[rIdx] = Array(colCount).fill('');
          // (v8) colCount に基づいて正しく値を設定
          while(newRows[rIdx].length < colCount) newRows[rIdx].push('');
          newRows[rIdx][c] = val;
          
          const updated: TableBlock = { ...currentBlock, rows: newRows };
          // (v8) dispatchReplace に (latestFrom) => ... を渡す
          this.dispatchReplace(view, updated, (latestFrom) => this.focusCellAt(view, latestFrom ?? this.block.from, rIdx, c));
        }, view, null); // ★ (v20)
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
  // console.log(`${logPrefix} buildDecorations()`);
  const builder = new RangeSetBuilder<Decoration>();
  // (v10) state (EditorState) を渡す
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
  create(state) {
    console.log(`${logPrefix} tableDecoField.create()`);
    return buildDecorations(state);
  },
  update(value, tr) {
    // console.log(`${logPrefix} tableDecoField.update()`);
    if (!tr.docChanged) return value;
    console.log(`${logPrefix} tableDecoField.update(): doc changed, rebuilding decorations.`);
    // (v10) tr.state (新しい EditorState) を渡す
    return buildDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f)
});

// ---- Keymap ----

// (v10 の getActiveCellContext)
function getActiveCellContext(view: EditorView) {
  // ★ (v23) ログ復活
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
  
  // (v8) view.state から最新の block を取得
  const block = parseTablesInDoc(view.state).find(b => b.from === from) ?? null;

  if (!block) {
    console.log(`${logPrefix} getActiveCellContext: FAILED (No block found at ${from})`);
    return null;
  }
  
  console.log(`${logPrefix} getActiveCellContext: SUCCESS (row: ${rc.row}, col: ${rc.col})`);
  return { ...rc, from, colCount, rowCount, block, el: focused as HTMLElement };
}

// (v10 の focusCell)
function focusCell(view: EditorView, from: number, row: number | null, col: number) {
  // ★ (v23) ログ復活
  console.log(`${logPrefix} focusCell(from: ${from}, row: ${row}, col: ${col})`);
  const container = document.querySelector(`.cm-md-table-widget[data-from="${from}"]`) as HTMLElement | null;
  if (!container) {
    console.warn(`${logPrefix} focusCell: Container [data-from="${from}"] not found.`);
    return;
  }

  let target: HTMLElement | null = null;
  if (row == null || row < 0) {
    // header
    target = container.querySelector(`thead tr > :nth-child(${col + 1})`) as HTMLElement | null;
  } else {
    // body
    const tr = container.querySelector(`tbody tr:nth-child(${row + 1})`) as HTMLElement | null;
    if (tr) target = tr.children[col] as HTMLElement | null;
  }
  
  // (v10) focusCellAt とは異なり、Widget インスタンスにアクセスできないため、
  //       isProgrammaticFocus フラグはここでは *セットできない*
  //       (v16 の blur リスナーが `relatedTarget` で処理するのを期待する)
  
  if (target) {
    // (v10) setTimeout でフォーカスを当てる
    setTimeout(() => {
        console.log(`${logPrefix} focusCell(async): Calling .focus() on target...`);
        target?.focus();
        // カーソルを末尾に
        try { // line 921
          if (target && target.firstChild instanceof Text) {
            const s = window.getSelection();
            const r = document.createRange();
            r.selectNodeContents(target);
            r.collapse(false);
            s?.removeAllRanges();
            s?.addRange(r); // line 928
          }
        } // ★★★ (v24) 修正: 構文エラーを修正 (catch を追加)
        catch { /* noop */ }
    }, 0);
  } else {
     console.warn(`${logPrefix} focusCell: Target cell (row: ${row}, col: ${col}) not found in container.`);
  }
}

// ★★★ (v19) cmdEnter 関数を削除 ★★★


// (v10 の Tab, Shift+Tab)
function cmdTab(view: EditorView): boolean {
  // ★ (v23) ログ復活
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
    return false; // デフォルトの Tab 動作 (テーブルから抜ける)
  }
  
  focusCell(view, from, nRow < 0 ? null : nRow, nCol);
  return true;
}
function cmdShiftTab(view: EditorView): boolean {
  // ★ (v23) ログ復活
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
    return false; // デフォルトの Shift+Tab 動作
  }
  
  focusCell(view, from, nRow < 0 ? null : nRow, nCol);
  return true;
}

// (v10 の 矢印キー移動)
function moveHorizontal(dir: 'left' | 'right') {
  return (view: EditorView): boolean => {
    // ★ (v23) ログ復活
    console.log(`${logPrefix} keymap: Arrow ${dir}`);
    const ctx = getActiveCellContext(view);
    if (!ctx) return false;

    // TODO: カーソル位置が端かチェック
    
    const { from, row, col, colCount } = ctx;
    const nCol = clamp(col + (dir === 'left' ? -1 : 1), 0, colCount - 1);
    
    if (nCol === col) {
      console.log(`${logPrefix} keymap: Arrow ${dir} (At edge)`);
      return false; // 端だった (デフォルトの矢印キー動作)
    }
    
    focusCell(view, from, row, nCol);
    return true;
  };
}
function moveVertical(dir: 'up' | 'down') {
  return (view: EditorView): boolean => {
    // ★ (v23) ログ復活
    console.log(`${logPrefix} keymap: Arrow ${dir}`);
    const ctx = getActiveCellContext(view);
    if (!ctx) return false;
    
    const { from, row, col, rowCount } = ctx;
    let nRow: number | null = row ?? -1; // -1 = header
    
    if (dir === 'up') {
      if (nRow === 0) nRow = null; // 1行目 -> ヘッダー
      else if (nRow > 0) nRow = nRow - 1; // 2行目以降
      else {
        console.log(`${logPrefix} keymap: Arrow ${dir} (At edge)`);
        return false; // ヘッダー (null) より上には行けない
      }
    } else {
      if (nRow === null) nRow = 0; // ヘッダー -> 1行目
      else if (nRow < rowCount - 1) nRow = nRow + 1; // 最終行より前
      else {
        console.log(`${logPrefix} keymap: Arrow ${dir} (At edge)`);
        return false; // 最終行
      }
    }
    
    focusCell(view, from, nRow, col);
    return true;
  };
}

// ★★★ (v23) 新規: PgUp/PgDn のための関数 ★★★
function moveVerticalPage(dir: 'up' | 'down') {
  return (view: EditorView): boolean => {
    console.log(`${logPrefix} keymap: Page ${dir}`);
    const ctx = getActiveCellContext(view);
    if (!ctx) return false;
    
    const { from, row, col, rowCount } = ctx;
    
    if (dir === 'up') {
      const targetRow = 0; // First data row
      if (rowCount === 0) return false; // データ行がない
      if (row === null || row === targetRow) {
         console.log(`${logPrefix} keymap: Page ${dir} (At top)`);
         return false; // 既に一番上 (ヘッダー or 1行目)
      }
      focusCell(view, from, targetRow, col);
    } else {
      const targetRow = rowCount - 1; // Last data row
      if (targetRow < 0) return false; // データ行がない
      if (row === targetRow) {
        console.log(`${logPrefix} keymap: Page ${dir} (At bottom)`);
        return false; // 既に一番下
      }
      focusCell(view, from, targetRow, col);
    }
    return true;
  };
}


// (v10)
function copySelectionTSV(view: EditorView): boolean {
  // TODO: 矩形選択
  // ★ (v23) ログ復活
  console.log(`${logPrefix} keymap: Mod-c (Not implemented)`);
  return false;
}

// (v19 の tableKeymap: Enter を削除)
// ★★★ (v23) 修正: PgUp/PgDn を追加 ★★★
export const tableKeymap = keymap.of([
  { key: 'ArrowLeft', run: moveHorizontal('left') },
  { key: 'ArrowRight', run: moveHorizontal('right') },
  { key: 'ArrowUp', run: moveVertical('up') },
  { key: 'ArrowDown', run: moveVertical('down') },
  // { key: 'Enter', run: cmdEnter }, // ★ (v19) 削除 (buildCell の keydown で処理)
  { key: 'PageUp', run: moveVerticalPage('up') },
  { key: 'PageDown', run: moveVerticalPage('down') },
  { key: 'Tab', run: cmdTab },
  { key: 'Shift-Tab', run: cmdShiftTab }, 
  { key: 'Mod-c', run: copySelectionTSV },
]);

// (v8)
export const tableExtension = [
  tableDecoField,
];