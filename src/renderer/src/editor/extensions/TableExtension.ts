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
  console.log(`${logPrefix} serializeTable()`);
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
      // <tbody> があり、その中に <tr> がある場合
      // rowEl.rowIndex は <thead> の行数を考慮したインデックス (e.g., thead 1行なら 1 から始まる)
      // <thead> が 1行 の場合、<tbody> の 1行目 (row: 0) は rowIndex: 1
      const theadRowCount = tbody.parentElement?.querySelector('thead')?.rows.length ?? 0;
      return { row: rowEl.rowIndex - theadRowCount, col };
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
  // ★ (v23) キー操作またはマウス操作による意図的な blur かを判定するフラグ
  private isIntentionalBlur = false;
  
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
    console.log(`${logPrefix} eq(): ${result}`);
    // ★ (v23) eq() で状態を引き継ぐロジックは（v24のリサイズ機能で）必要
    // if (result && other instanceof TableWidget) {
    //   (other as TableWidget).currentColWidths = this.currentColWidths;
    // }
    return result;
  }

  // (v8)
  ignoreEvent(event: Event): boolean {
    // key イベントはエディタに流す（keymap を効かせる）
    // それ以外の DOM イベント (click, input, contextmenu...) はウィジェット内で処理
    const ignored = event.type !== 'keydown' && event.type !== 'keyup';
    // console.log(`${logPrefix} ignoreEvent(${event.type}): ${ignored}`); // ログが多すぎるため v18 でコメントアウト
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
          // ★ (v23) blur リスナーがチェックできるよう、isIntentionalBlur もセット
          this.isIntentionalBlur = true;
          
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
      setTimeout(tryFocus, 50); // (v20) 0ms -> 50ms に延長し、DOM更新を待つ
    } catch (e) {
      console.error(`${logPrefix} focusCellAt: Error`, e);
    }
  }

  // (v8 の getBlockAtFrom)
  private getBlockAtFrom = (state: EditorState, from: number): TableBlock | null => {
    console.log(`${logPrefix} getBlockAtFrom(from: ${from})`);
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

    // ★ (v23)
    const closeOnOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        console.log(`${logPrefix} Closing context menu (click outside)`);
        menu.remove();
        // ★ (v23) フラグのリセットは mousedown / focus が行う
        // this.isOpeningContextMenu = false; 
        document.removeEventListener('click', closeOnOutside);
        document.removeEventListener('mousedown', closeOnOutside); // (v23) mousedown も監視
      }
    };
    // (v23) mousedown も監視
    setTimeout(() => {
        document.addEventListener('click', closeOnOutside);
        document.addEventListener('mousedown', closeOnOutside);
    }, 0);


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

  // ★★★ 修正 (v23): `focus`, `blur`, `keydown`, `mousedown` リスナー ★★★
  private buildCell = (
    tag: 'th' | 'td',
    text: string,
    col: number,
    row: number | null,
    al: Align,
    updateValue: (val: string) => void,
    view: EditorView
  ) => {
    console.log(`${logPrefix} buildCell(tag: ${tag}, row: ${row}, col: ${col})`);
    const el = document.createElement(tag);
    el.contentEditable = 'true';
    el.textContent = text;
    // (スタイル設定 ... 省略)
    el.style.minWidth = '50px';
    el.style.textAlign = al ?? 'left';
    el.style.padding = '4px 8px';
    el.style.border = '1px solid #ccc';
    el.style.position = 'relative'; 
    el.style.outline = 'none';

    // ★ (v23) focus リスナー: すべてのフラグをリセット
    el.addEventListener('focus', () => {
      console.log(`${logPrefix} FOCUS (row: ${row}, col: ${col})`);
      el.style.boxShadow = 'inset 0 0 0 2px #007bff';
      
      // ★ (v23) セルがフォーカスを得たら、すべての「意図的blur」フラグをリセット
      this.isProgrammaticFocus = false;
      this.isIntentionalBlur = false;
      this.isOpeningContextMenu = false;
    });
    
    const extractValue = () => (el.textContent ?? '').replace(/\r?\n/g, ' ');
    const commit = () => {
      // (v11) DOM に接続されていない（=再描画で破棄された）セルのコミットは防ぐ
      if (!el.isConnected) {
        console.log(`${logPrefix} commit() SKIPPED (row: ${row}, col: ${col}) - element disconnected`);
        return;
      }
      console.log(`${logPrefix} commit() CALLED (row: ${row}, col: ${col})`);
      updateValue(extractValue());
    }
    
    // ★ (v23) blur リスナー: 3つのフラグをチェック
    el.addEventListener('blur', (e: FocusEvent) => {
      console.log(`${logPrefix} BLUR (row: ${row}, col: ${col})`);
      el.style.boxShadow = 'none';

      // ★ (v23) 最優先チェック: Enter/矢印/Tab/MouseDown が（直前に）発火していたら、
      //    この blur はその結果なので、コミットをスキップする
      if (this.isIntentionalBlur) {
        console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Skipped commit (blur was intentional)`);
        // (v23) フラグは focus リスナーがリセットする
        // this.isIntentionalBlur = false; 
        return; 
      }

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
        // (v14 -> v21) フラグのリセットは focus / mousedown が行う
        return; 
      }
      
      // (v10) フォーカスがテーブル外に移動した、または不明
      console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Committing (focus left table or lost)`);
      commit(); 
    });

    el.addEventListener('input', () => {
      // noop
    });
    
    // ★★★ (v23) keydown リスナー: (v21のロジック + isIntentionalBlur) ★★★
    el.addEventListener('keydown', (e) => {
      console.log(`${logPrefix} KEYDOWN (row: ${row}, col: ${col}): ${e.key}`);
      
      if (e.key === 'Enter') {
        e.preventDefault(); // ★ セル内改行を防ぐ
        
        // ★ (v23) これから blur が発生することをフラグで伝える
        this.isIntentionalBlur = true;
        
        console.log(`${logPrefix} KEYDOWN: Enter. Handling move/add row (v21)...`);

        const container = getTableWidgetContainer(el);
        if (!container) return;
        
        const from = parseInt(container.dataset.from!, 10);
        const rowCount = parseInt(container.dataset.rowCount!, 10);
        const colCount = parseInt(container.dataset.colCount!, 10);
        
        const rc = getCellRC(el); // { row: number | null, col: number }
        if (!rc || rc.row == null) { // ヘッダーでは Enter を無視
            console.log(`${logPrefix} KEYDOWN: Enter pressed in header, ignoring.`);
            return;
        }
        
        const currentRow = rc.row;
        const currentCol = rc.col;

        // ★ (v20) 1. DO NOT commit(). Read value directly.
        const val = extractValue();
        
        // ★ (v20) 2. Get the latest block from state.
        const currentBlock = this.getBlockAtFrom(view.state, from) ?? this.block;
        
        // ★ (v20) 3. Create the updated block (with saved value) IN MEMORY.
        const newRows = currentBlock.rows.map((r, i) => (i === currentRow ? [...r] : r.slice()));
        if (!newRows[currentRow]) newRows[currentRow] = Array(colCount).fill('');
        while(newRows[currentRow].length < colCount) newRows[currentRow].push('');
        newRows[currentRow][currentCol] = val;
        
        const updatedBlock: TableBlock = { ...currentBlock, rows: newRows };
        

        if (currentRow < rowCount - 1) {
            // ★ 最後以外の行 → 次の行にフォーカス
            const nextRow = currentRow + 1;
            console.log(`${logPrefix} KEYDOWN: Enter (v21) -> Saving and Moving to next row (${nextRow}, ${currentCol})`);
            
            // ★ (v20) 4a. Dispatch ONCE.
            this.dispatchReplace(view, updatedBlock, (latestFrom) => {
                this.focusCellAt(view, latestFrom ?? from, nextRow, currentCol);
            });
            
        } else {
            // ★ 最後の行 → 新規行追加
            console.log(`${logPrefix} KEYDOWN: Enter (v21 End of table) -> Saving and Adding row`);
            
            // ★ (v20) 4b. Add new row to the IN-MEMORY block.
            const newRow = Array(colCount).fill('');
            updatedBlock.rows.push(newRow); // Mutate the block we just made
            
            const newRowIndex = rowCount; // 0-indexed, so rowCount is the new index
            
            // ★ (v20) 4c. Dispatch ONCE.
            this.dispatchReplace(view, updatedBlock, (latestFrom) => {
                console.log(`${logPrefix} KEYDOWN: Enter (v21 Add row) -> Focusing new row (${newRowIndex}, ${currentCol})`);
                this.focusCellAt(view, latestFrom ?? from, newRowIndex, currentCol);
            });
        }
        return;
      }
      
      // (v9) 矢印キーやTabでは commit() しない（keymap に任せる）
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab'].includes(e.key)) {
          console.log(`${logPrefix} KEYDOWN: Arrow/Tab. Passing event to keymap.`);
          // ★ (v23) これから blur が発生することをフラグで伝える
          this.isIntentionalBlur = true;
      }
    });

    // ★ (v23) mousedown リスナー
    el.addEventListener('mousedown', (e) => {
      console.log(`${logPrefix} mousedown (row: ${row}, col: ${col})`);
      
      // ★ (v23) これから blur が発生することをフラグで伝える
      //    (ただし、右クリックの場合は contextmenu リスナーが優先される)
      if (e.button === 0) { // 左クリックのみ
        this.isIntentionalBlur = true;
      }
      
      // (v21) v14 のフラグリセットロジックを (v16 と同様に) mousedown に移動
      if (this.isProgrammaticFocus) {
          console.log(`${logPrefix} mousedown: Resetting programmatic focus flag`);
          this.isProgrammaticFocus = false;
      }
      if (this.isOpeningContextMenu) {
           console.log(`${logPrefix} mousedown: Resetting context menu flag`);
          this.isOpeningContextMenu = false;
      }
    });

    // (v14 の contextmenu リスナー)
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      console.log(`${logPrefix} contextmenu (row: ${row}, col: ${col})`);
      
      // (v14) これから `blur` が発生することをフラグで伝える
      this.isOpeningContextMenu = true;
      // (v23) 左クリックでのフラグはリセット
      this.isIntentionalBlur = false;
      
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
    
    // (v24) toDOM には colgroup/resize ハンドラは不要（v23互換のため）
    // v23 のロジックを維持

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

    // (v8) ヘッダーセルの構築
    headers.forEach((text, col) => {
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
      }, view);
      trh.appendChild(th);
    });
    thead.appendChild(trh);

    // (v8) ボディセルの構築
    const tbody = document.createElement('tbody');
    this.block.rows.forEach((row, rIdx) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
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
  console.log(`${logPrefix} buildDecorations()`);
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
    console.log(`${logPrefix} tableDecoField.update()`);
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
  
  if (target) {
    // (v10) setTimeout でフォーカスを当てる
    setTimeout(() => {
        console.log(`${logPrefix} focusCell(async): Calling .focus() on target...`);
        // (v23)
        // ここで isProgrammaticFocus = true にしたいが、widget インスタンスに
        // アクセスできない。
        // 代わりに、focusCell を呼び出す keydown 側 (buildCell or moveHorizontal) が
        // isIntentionalBlur = true にセットするので、
        // .focus() がトリガーする blur は v23 の blur リスナーで
        // "Skipped commit (blur was intentional)" となり、正しくスキップされる。
        
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
    }, 50); // (v20) 0ms -> 50ms に延長
  } else {
     console.warn(`${logPrefix} focusCell: Target cell (row: ${row}, col: ${col}) not found in container.`);
  }
}

// ★★★ (v19) cmdEnter 関数を削除 ★★★


// (v10 の Tab, Shift+Tab)
function cmdTab(view: EditorView): boolean {
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

// (v10)
function copySelectionTSV(view: EditorView): boolean {
  // TODO: 矩形選択
  console.log(`${logPrefix} keymap: Mod-c (Not implemented)`);
  return false;
}

// (v19 の tableKeymap: Enter を削除)
export const tableKeymap = keymap.of([
  { key: 'ArrowLeft', run: moveHorizontal('left') },
  { key: 'ArrowRight', run: moveHorizontal('right') },
  { key: 'ArrowUp', run: moveVertical('up') },
  { key: 'ArrowDown', run: moveVertical('down') },
  // { key: 'Enter', run: cmdEnter }, // ★ (v19) 削除
  { key: 'Tab', run: cmdTab },
  { key: 'Shift-Tab', run: cmdShiftTab }, 
  { key: 'Mod-c', run: copySelectionTSV },
]);

// (v8)
export const tableExtension = [
  tableDecoField,
];