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
  RangeSet,
  StateEffect // ★ StateEffect をインポート
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

// ★ ---- 列幅管理 (StateField) ---- ★

/**
 * 列幅の変更をディスパッチするための Effect
 * { from: テーブルの開始位置, widths: [列1幅, 列2幅, ...] }
 */
export const updateColWidthEffect = StateEffect.define<{ from: number; widths: number[] }>();

/**
 * 列幅をテーブルの 'from' 位置をキーとして保持する StateField
 * マップ: { [tableFrom: number]: number[] }
 */
export const colWidthsField = StateField.define<{ [from: number]: number[] }>({
  create() {
    return {};
  },
  update(value, tr) {
    const newMap: { [from: number]: number[] } = {};

    // 1. ドキュメントの変更（文字入力など）に応じて、既存の 'from' 位置をマッピング
    if (tr.docChanged) {
      for (const fromKey in value) {
        const oldFrom = Number(fromKey);
        // 'from' の位置を新しいドキュメントでの位置に変換
        const newFrom = tr.changes.mapPos(oldFrom, 1); // (v2) 挿入時も考慮
        if (newFrom !== null) {
          // TODO: テーブルが削除された場合 (mapPos が null になるか？) のクリーアップ
          newMap[newFrom] = value[oldFrom];
          console.log(`${logPrefix} colWidthsField.update: Remapped from ${oldFrom} -> ${newFrom}`); // (v22) ログ追加
        }
      }
    } else {
      // 変更がなければ単純にコピー
      Object.assign(newMap, value);
    }
    
    // 2. 'updateColWidthEffect' があれば、新しい幅でマップを更新
    for (const effect of tr.effects) {
      if (effect.is(updateColWidthEffect)) {
        const { from, widths } = effect.value;
        // 'from' は (v22) により、マッピング後の newFrom が渡される
        console.log(`${logPrefix} colWidthsField.update: Applying widths [${widths.join(', ')}] for newFrom: ${from}`); // (v22) ログ追加
        newMap[from] = widths;
      }
    }
    return newMap;
  }
});


// (v8) テーブルを Markdown テキストに戻す
function serializeTable(block: TableBlock): string {
  console.log(`${logPrefix} serializeTable()`); // (v21) ログ有効化
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
  console.log(`${logPrefix} parseTablesInDoc()`); // (v21) ログ有効化
  const blocks: TableBlock[] = [];
  const tree = syntaxTree(state);

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Table') return;

      const from = node.from;
      const to = node.to;
      const headers: string[] = []; // ★ 修正: = [] を追加
      const aligns: Align[] = []; // ★ 修正: = [] を追加
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
  console.log(`${logPrefix} parseTablesInDoc: ${blocks.length} tables found.`); // (v21) ログ有効化
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
  
  // ★ (v20) コンストラクタで widths を受け取る
  constructor(private block: TableBlock, private widths: number[] | null) {
    super();
    console.log(`${logPrefix} new TableWidget() [from: ${block.from}]`); // (v21) ログ有効化
  }

  // ★ (v20) eq で widths も比較する
  eq(other: WidgetType): boolean {
    const o = other as TableWidget;
    // 1. Markdown テキストの内容を比較
    if (
      o.block.from !== this.block.from ||
      o.block.to !== this.block.to ||
      o.block.headers.join('|') !== this.block.headers.join('|') ||
      o.block.rows.map(r => r.join('|')).join('||') !== this.block.rows.map(r => r.join('|')).join('||')
    ) return false;

    // 2. 列幅の配列を比較
    const w1 = this.widths ?? [];
    const w2 = o.widths ?? [];
    if (w1.length !== w2.length) return false;
    for (let i = 0; i < w1.length; i++) {
      if (w1[i] !== w2[i]) return false;
    }
    
    console.log(`${logPrefix} eq(): true`); // (v21) ログ有効化
    return true;
  }

  // (v8)
  ignoreEvent(event: Event): boolean {
    // key イベントはエディタに流す（keymap を効かせる）
    // それ以外の DOM イベント (click, input, contextmenu...) はウィジェット内で処理
    const ignored = event.type !== 'keydown' && event.type !== 'keyup';
    // console.log(`${logPrefix} ignoreEvent(${event.type}): ${ignored}`); // ログが多すぎるため v18 でコメントアウト
    return ignored;
  }

  // ★ (v22) dispatchReplace を修正: newWidths を受け取り、Effect を自動で追加する
  private dispatchReplace = (
    view: EditorView, 
    updated: TableBlock, 
    newWidths: number[] | null = null, // ★ (v22)
    after?: (latestFrom?: number) => void
  ) => {
    console.log(`${logPrefix} dispatchReplace() CALLED (newWidths: ${newWidths ? newWidths.length : 'null'})`);
    
    setTimeout(() => {
      // (v8) 古い this.block.from をキーに、最新の view.state から最新のブロック範囲を取得
      const initialFrom = this.block.from;
      console.log(`${logPrefix} dispatchReplace(async): Searching block at initialFrom: ${initialFrom}`); // (v21) ログ有効化
      
      const latestBlock = parseTablesInDoc(view.state).find(b => b.from === initialFrom);
      
      // (v8) ブロックが見つからない (e.g. 削除された) 場合は何もしない
      if (!latestBlock) {
           console.error(`${logPrefix} dispatchReplace(async): Block not found at ${initialFrom}!`);
           return;
      }
      
      console.log(`${logPrefix} dispatchReplace(async): Block found [from: ${latestBlock.from}, to: ${latestBlock.to}]`); // (v21) ログ有効化
      // (v8) 最新のブロック情報を使って Markdown テキストを生成
      const newText = serializeTable({ ...updated, from: latestBlock.from, to: latestBlock.to });
      
      // (v8) 最新の from/to を使って変更トランザクションを作成
      const trSpec: TransactionSpec = {
        changes: { from: latestBlock.from, to: latestBlock.to, insert: newText }
      };

      // ★ (v22) トランザクションを先に *計算* して、変更後の 'from' を取得
      // ★ (v24) 修正: .tr は不要
      const tr = view.state.update(trSpec);
      // (v22) 挿入や削除でブロックが移動した後の新しい 'from'
      const newFrom = tr.changes.mapPos(latestBlock.from, 1); 

      if (newWidths && newFrom !== null) {
          console.log(`${logPrefix} dispatchReplace(async): Adding updateColWidthEffect for newFrom: ${newFrom}`);
          trSpec.effects = [
              // ★ (v24) 修正: .dispatch -> .of
              updateColWidthEffect.of({ from: newFrom, widths: newWidths })
          ];
      } else if (newWidths) {
          console.warn(`${logPrefix} dispatchReplace(async): Could not mapPos for 'from' ${latestBlock.from}, widths not saved.`);
      }

      console.log(`${logPrefix} dispatchReplace(async): DISPATCHING...`);
      view.dispatch(trSpec); // ★ (v22) Effect が含まれた Spec をディスパッチ
      console.log(`${logPrefix} dispatchReplace(async): DISPATCHED`);
      
      if (after) {
          console.log(`${logPrefix} dispatchReplace(async): Calling 'after' callback...`);
          // ★ (v22) after にも newFrom を渡す
          after(newFrom ?? latestBlock.from);
      }
    }, 0); 
  }


  // (v16 の focusCellAt)
  public focusCellAt = (view: EditorView, from: number, row: number | null, col: number) => { // ★ (v18) public に変更
    console.log(`${logPrefix} focusCellAt(from: ${from}, row: ${row}, col: ${col})`); // (v21) ログ有効化
    try {
      const tryFocus = () => {
        console.log(`${logPrefix} focusCellAt(async): Trying to focus...`); // (v21) ログ有効化
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
          console.log(`${logPrefix} focusCellAt(async): Target found, setting flag and calling .focus()`); // (v21) ログ有効化
          
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
    console.log(`${logPrefix} getBlockAtFrom(from: ${from})`); // (v21) ログ有効化
    const blocks = parseTablesInDoc(state);
    const block = blocks.find(b => b.from === from) ?? null;
    if (!block) console.warn(`${logPrefix} getBlockAtFrom: Block not found at ${from}`);
    return block;
  }

  // ---- Row/Col ops ----
  // (v15 の Row/Col 操作)
  private insertRow = (view: EditorView, container: HTMLElement, col: number, row: number, where: 'above' | 'below') => {
    console.log(`${logPrefix} insertRow(row: ${row}, where: ${where})`); // (v21) ログ有効化
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
    const colCount = Math.max(block.headers.length, ...block.rows.map(r => r.length));
    const at = where === 'above' ? row : row + 1;
    const newRows = block.rows.slice();
    newRows.splice(at, 0, Array(colCount).fill(''));
    const updated: TableBlock = { ...block, rows: newRows };
    // ★ (v22) newWidths=null で dispatchReplace を呼ぶ (幅は自動で引き継がれる)
    this.dispatchReplace(view, updated, null, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, at, col));
  }
  private deleteRow = (view: EditorView, container: HTMLElement, row: number) => {
    console.log(`${logPrefix} deleteRow(row: ${row})`); // (v21) ログ有効化
    const from = parseInt(container.dataset.from!, 10);
    const block = this.getBlockAtFrom(view.state, from) ?? this.block;
    if (block.rows.length === 0) return;
    const newRows = block.rows.slice();
    const focusRow = Math.max(0, Math.min(row, newRows.length - 2));
    newRows.splice(row, 1);
    const updated: TableBlock = { ...block, rows: newRows };
    // ★ (v22) newWidths=null で dispatchReplace を呼ぶ (幅は自動で引き継がれる)
    this.dispatchReplace(view, updated, null, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, focusRow, 0));
  }
  // ★ (v15) row を引数で受け取る
  private insertCol = (view: EditorView, container: HTMLElement, col: number, row: number | null, where: 'left' | 'right') => {
    console.log(`${logPrefix} insertCol(col: ${col}, row: ${row}, where: ${where})`); // (v21) ログ有効化
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
    
    // ★ (v22) 列挿入時に widths 情報を更新
    const currentWidths = (view.state.field(colWidthsField) ?? {})[from];
    let newWidths: number[] | null = null;
    if (currentWidths) {
        newWidths = currentWidths.slice();
        newWidths.splice(at, 0, 100); // 新しい列にデフォルト幅 100px を挿入
    }

    // ★ (v22) dispatchReplace に newWidths を渡す
    this.dispatchReplace(view, updated, newWidths, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, row, at));
  }
  private deleteCol = (view: EditorView, container: HTMLElement, col: number) => {
    console.log(`${logPrefix} deleteCol(col: ${col})`); // (v21) ログ有効化
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
    
    // ★ (v22) 列削除時に widths 情報を更新
    const currentWidths = (view.state.field(colWidthsField) ?? {})[from];
    let newWidths: number[] | null = null;
    if (currentWidths) {
        newWidths = currentWidths.slice();
        newWidths.splice(col, 1); // 対応する幅を削除
    }

    // ★ (v22) dispatchReplace に newWidths を渡す
    this.dispatchReplace(view, updated, newWidths, (latestFrom) => this.focusCellAt(view, latestFrom ?? from, 0, newCol));
  }

  // (v14 の showContextMenu)
  private showContextMenu = (view: EditorView, container: HTMLElement, rc: { row: number | null; col: number }, x: number, y: number) => {
    console.log(`${logPrefix} showContextMenu(row: ${rc.row}, col: ${rc.col})`); // (v21) ログ有効化
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
          console.log(`${logPrefix} Menu item click: ${label}`); // (v21) ログ有効化
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
        console.log(`${logPrefix} Closing context menu (click outside)`); // (v21) ログ有効化
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

  // ★ (v21) リサイズハンドルのロジック (レイアウト崩れ対策)
  private createResizer(view: EditorView, th: HTMLTableCellElement, colIndex: number) {
      const resizer = document.createElement('div');
      resizer.className = 'cm-table-resizer';
      
      resizer.addEventListener('mousedown', (e: MouseEvent) => {
          // ★ (v23) 修正: 左クリック (button: 0) 以外は無視
          if (e.button !== 0) {
            return;
          }

          e.preventDefault();
          e.stopPropagation();
          
          if (!this.container) return;
          const table = this.container.querySelector('table');
          if (!table) return;
          
          const colgroup = table.querySelector('colgroup');
          if (!colgroup) return; // colgroup がないとリサイズできない
          const cols = Array.from(colgroup.children) as HTMLTableColElement[];
          
          console.log(`${logPrefix} [RESIZE] mousedown (col: ${colIndex})`); // (v21) ログ有効化

          // ★★★ v21 修正:
          // 1. まず、全列の *現在の* offsetWidth を読み取る
          const currentWidths = cols.map(c => c.offsetWidth);
          
          // 2. 読み取った幅を <col> 要素に明示的にセットする
          //    これにより、table-layout: fixed に切り替わった瞬間にレイアウトが
          //    崩れるのを防ぐ
          for (let i = 0; i < cols.length; i++) {
              cols[i].style.width = `${currentWidths[i]}px`;
          }
          
          const startX = e.clientX;
          // 3. 読み取った幅をドラッグ開始幅として使う
          const startWidth = currentWidths[colIndex]; 
          
          // 4. (v20) ドラッグ中は table-layout: fixed が必須
          table.style.tableLayout = 'fixed';
          // ★ (v21) 幅が固定されたので、テーブル幅は 'auto' にする
          table.style.width = 'auto';
          console.log(`${logPrefix} [RESIZE] mousedown: Set table-layout: fixed, width: auto, applied current widths.`);

          const onMouseMove = (e: MouseEvent) => {
              const deltaX = e.clientX - startX;
              const newWidth = Math.max(50, startWidth + deltaX); // 最小幅を 50px に
              cols[colIndex].style.width = `${newWidth}px`;
          };

          const onMouseUp = () => {
              console.log(`${logPrefix} [RESIZE] mouseup`); // (v21) ログ有効化
              window.removeEventListener('mousemove', onMouseMove);
              window.removeEventListener('mouseup', onMouseUp);

              // 最終的な幅を <col> 要素から読み取り、配列にする
              const finalWidths = cols.map(c => c.offsetWidth);
              
              // (v20) 最新の from 位置を取得して Effect をディスパッチ
              const latestFrom = (this.getBlockAtFrom(view.state, this.block.from) ?? this.block).from;
              
              console.log(`${logPrefix} [RESIZE] mouseup: Dispatching new widths [${finalWidths.join(', ')}] for from: ${latestFrom}`); // (v21) ログ有効化
              view.dispatch({
                  // ★ (v24) 修正: .dispatch -> .of
                  effects: updateColWidthEffect.of({ from: latestFrom, widths: finalWidths })
              });
          };

          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
      });
      
      return resizer;
  }

  // ★★★ 修正 (v19): `focus`, `blur`, `keydown` リスナー ★★★
  private buildCell = (
    tag: 'th' | 'td',
    text: string,
    col: number,
    row: number | null,
    al: Align,
    updateValue: (val: string) => void,
    view: EditorView // ★ (v20) view を受け取る
  ) => {
    console.log(`${logPrefix} buildCell(tag: ${tag}, row: ${row}, col: ${col})`); // (v21) ログ有効化
    const el = document.createElement(tag);
    el.contentEditable = 'true';
    el.textContent = text;
    // (スタイル設定 ... 省略)
    el.style.minWidth = '50px';
    el.style.textAlign = al ?? 'left';
    el.style.padding = '4px 8px';
    el.style.border = '1px solid #ccc';
    el.style.position = 'relative'; // ★ (v20) リサイズハンドルのために relative が必要
    el.style.outline = 'none';

    // ★ (v20) ヘッダーセル (th) の場合のみリサイズハンドルを追加
    if (tag === 'th') {
        const resizer = this.createResizer(view, el, col);
        el.appendChild(resizer);
    }

    // ★ (v16) focus リスナー: プログラムフォーカスフラグをリセット
    el.addEventListener('focus', () => {
      console.log(`${logPrefix} FOCUS (row: ${row}, col: ${col})`); // (v21) ログ有効化
      el.style.boxShadow = 'inset 0 0 0 2px #007bff';
      
      // ★ (v16) フォーカスを受け取ったので、フラグをリセット
      this.isProgrammaticFocus = false;
    });
    
    const extractValue = () => (el.textContent ?? '').replace(/\r?\n/g, ' ');

    // ★ (v20) commit ロジックを修正
    const commit = () => {
      // (v22) commit 時の this.block は古い可能性があるので、view.state から最新を取得
      const latestBlock = this.getBlockAtFrom(view.state, this.block.from);
      if (!latestBlock) {
          console.warn(`${logPrefix} commit() SKIPPED (row: ${row}, col: ${col}): Latest block not found.`);
          return;
      }

      const currentValue = (tag === 'th' ? latestBlock.headers[col] : (latestBlock.rows[row!]?.[col] ?? ''));
      const newValue = extractValue();
      if (currentValue === newValue) {
        console.log(`${logPrefix} commit() SKIPPED (row: ${row}, col: ${col}): Value did not change.`); // (v21) ログ有効化
        return;
      }
      console.log(`${logPrefix} commit() CALLED (row: ${row}, col: ${col})`); // (v21) ログ有効化
      updateValue(newValue);
    }
    
    // ★ (v16) blur リスナー: isProgrammaticFocus をチェック
    el.addEventListener('blur', (e: FocusEvent) => {
      el.style.boxShadow = 'none';

      // ★ (v16) もし `focusCellAt` が（直前に）発火していたら、
      //    この blur はその結果なので、コミットをスキップする
      if (this.isProgrammaticFocus) {
        console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Skipped commit (blur was programmatic)`); // (v21) ログ有効化
        // (v16) フラグは focus リスナーがリセットする
        return; 
      }

      // (v14) もし `contextmenu` が *直前* に発火していたら、
      //    この blur はメニューを開くためのものなので、コミットをスキップする
      if (this.isOpeningContextMenu) {
        console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Skipped commit (blur was from context menu)`); // (v21) ログ有効化
        // (v14) フラグをここでリセット
        this.isOpeningContextMenu = false; 
        return; 
      }
      
      // (v10) フォーカスがテーブル内の別のセルに移動したかチェック
      const relatedTarget = e.relatedTarget as HTMLElement | null;
      const container = this.container; 

      if (container && relatedTarget && container.contains(relatedTarget)) {
        console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Skipped commit (focus moved to another cell)`); // (v21) ログ有効化
        return; 
      }
      
      // (v11) セルが DOM から切り離されていたらコミットしない
      if (!el.isConnected) {
        console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Skipped commit (element is disconnected)`); // (v21) ログ有効化
        return; 
      }

      // (v10) フォーカスがテーブル外に移動した、または不明
      console.log(`${logPrefix} BLUR (row: ${row}, col: ${col}): Committing (focus left table or lost)`); // (v21) ログ有効化
      commit(); 
    });

    el.addEventListener('input', () => {
      // noop
    });
    
    // ★★★ (v19) keydown リスナー: `index.html` のロジックを採用 ★★★
    el.addEventListener('keydown', (e) => {
      console.log(`${logPrefix} KEYDOWN (row: ${row}, col: ${col}): ${e.key}`); // (v21) ログ有効化
      
      if (e.key === 'Enter') {
        e.preventDefault(); // ★ セル内改行を防ぐ
        console.log(`${logPrefix} KEYDOWN: Enter. Handling move/add row...`); // (v21) ログ有効化

        // (v19) index.html と同様のロジックをここに実装
        const container = getTableWidgetContainer(el);
        if (!container) return;
        
        const from = parseInt(container.dataset.from!, 10);
        const rowCount = parseInt(container.dataset.rowCount!, 10);
        const colCount = parseInt(container.dataset.colCount!, 10);
        
        const rc = getCellRC(el); // { row: number | null, col: number }
        if (!rc || rc.row == null) { // ヘッダーでは Enter を無視
            console.log(`${logPrefix} KEYDOWN: Enter pressed in header, ignoring.`); // (v21) ログ有効化
            return;
        }
        
        const currentRow = rc.row;
        const currentCol = rc.col;

        // ★★★ 1. まず現在のセルをコミット（保存）する ★★★
        // （`dispatchReplace` は非同期なので、移動/行追加の *前* に呼ぶ）
        commit();

        if (currentRow < rowCount - 1) {
            // ★ 最後以外の行 → 次の行にフォーカス
            const nextRow = currentRow + 1;
            console.log(`${logPrefix} KEYDOWN: Enter -> Move to next row (${nextRow}, ${currentCol})`); // (v21) ログ有効化
            this.focusCellAt(view, from, nextRow, currentCol);
            
        } else {
            // ★ 最後の行 → 新規行追加
            console.log(`${logPrefix} KEYDOWN: Enter (End of table) -> Add row`); // (v21) ログ有効化
            const block = this.getBlockAtFrom(view.state, from) ?? this.block;
            const newRow = Array(colCount).fill('');
            const updated: TableBlock = { ...block, rows: [...block.rows, newRow] };
            
            // ★ (v22) dispatchReplace に width=null で渡す
            this.dispatchReplace(view, updated, null, (latestFrom) => {
                const newRowIndex = rowCount; // 0-indexed なので rowCount が新しい行のインデックス
                console.log(`${logPrefix} KEYDOWN: Enter (Add row) -> Focusing new row (${newRowIndex}, ${currentCol})`); // (v21) ログ有効化
                this.focusCellAt(view, latestFrom ?? from, newRowIndex, currentCol);
            });
        }
        return;
      }
      
      // (v9) 矢印キーやTabでは commit() しない（keymap に任せる）
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift-Tab', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) { // (v22) キー追加
          console.log(`${logPrefix} KEYDOWN: Arrow/Tab/Nav. Passing event to keymap.`); // (v21) ログ有効化
      }
    });

    // (v14 の mousedown リスナー)
    el.addEventListener('mousedown', (e) => {
      console.log(`${logPrefix} mousedown (row: ${row}, col: ${col})`); // (v21) ログ有効化
      
      // ★ (v23) 修正: 左クリック(button: 0) の場合のみフラグをリセット
      if (e.button === 0) {
        // (v14) 左クリックは必ずメニューフラグをリセットする
        this.isOpeningContextMenu = false;
      }
    });

    // (v14 の contextmenu リスナー)
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      console.log(`${logPrefix} contextmenu (row: ${row}, col: ${col})`); // (v21) ログ有効化
      
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
    container.style.overflowX = 'auto'; // (v20) 幅がはみ出た場合にスクロール

    const table = document.createElement('table');
    table.style.borderCollapse = 'collapse';
    // ★ (v20) table-layout と width は widths に依存
    table.style.tableLayout = this.widths ? 'fixed' : 'auto';
    table.style.width = this.widths ? 'auto' : '100%';


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
    for (let i = 0; i < colCount; i++) {
        const colEl = document.createElement('col');
        if (this.widths && this.widths[i]) {
            colEl.style.width = `${this.widths[i]}px`;
        }
        colgroup.appendChild(colEl);
    }
    table.appendChild(colgroup);

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    trh.style.backgroundColor = '#f8f8f8';

    const headers = Array.from({ length: colCount }, (_, i) => this.block.headers[i] ?? '');
    const aligns = Array.from({ length: colCount }, (_, i) => this.block.aligns[i] ?? null);

    // (v8) ヘッダーセルの構築
    headers.forEach((text, col) => {
      // ★ (v20) view を渡す
      const th = this.buildCell('th', text, col, null, aligns[col] ?? null, (val) => {
        // (v8) commit (updateValue) 時に最新の block を取得
        console.log(`${logPrefix} updateValue (Header col: ${col}): '${val}'`); // (v21) ログ有効化
        const currentBlock = this.getBlockAtFrom(view.state, this.block.from) ?? this.block;
        
        // (v20) ヘッダーの長さに合わせて aligns も更新する
        const newHeaders = headers.map((h, i) => (i === col ? val : h));
        const newAligns = aligns.slice();
        while(newAligns.length < newHeaders.length) newAligns.push(null);

        const updated: TableBlock = {
          ...currentBlock,
          headers: newHeaders,
          aligns: newAligns
        };
        // ★ (v22) newWidths=null で dispatchReplace を呼ぶ
        this.dispatchReplace(view, updated, null, (latestFrom) => this.focusCellAt(view, latestFrom ?? this.block.from, null, col));
      }, view);
      trh.appendChild(th);
    });
    thead.appendChild(trh);

    // (v8) ボディセルの構築
    const tbody = document.createElement('tbody');
    this.block.rows.forEach((row, rIdx) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        // ★ (v20) view を渡す
        const td = this.buildCell('td', row[c] ?? '', c, rIdx, aligns[c] ?? null, (val) => {
          // (v8) commit (updateValue) 時に最新の block を取得
          console.log(`${logPrefix} updateValue (Body row: ${rIdx}, col: ${c}): '${val}'`); // (v21) ログ有効化
          const currentBlock = this.getBlockAtFrom(view.state, this.block.from) ?? this.block;
          
          const newRows = currentBlock.rows.map((r, i) => (i === rIdx ? [...r] : r.slice()));
          if (!newRows[rIdx]) newRows[rIdx] = Array(colCount).fill('');
          // (v8) colCount に基づいて正しく値を設定
          while(newRows[rIdx].length < colCount) newRows[rIdx].push('');
          newRows[rIdx][c] = val;
          
          const updated: TableBlock = { ...currentBlock, rows: newRows };
          // ★ (v22) newWidths=null で dispatchReplace を呼ぶ
          this.dispatchReplace(view, updated, null, (latestFrom) => this.focusCellAt(view, latestFrom ?? this.block.from, rIdx, c));
        }, view);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    const styleSel = document.createElement('style');
    // ★ (v20) リサイズハンドルのスタイルを追加
    styleSel.textContent = `
      .cm-md-table-widget td[data-selected="true"],
      .cm-md-table-widget th[data-selected="true"] {
        background-color: #d0e0ff;
      }
      .cm-table-resizer {
        position: absolute;
        top: 0;
        right: -4px;
        width: 8px;
        height: 100%;
        cursor: col-resize;
        z-index: 10;
        /* background-color: rgba(0, 128, 255, 0.3); */ /* デバッグ用 */
      }
      .cm-table-resizer:hover {
        background-color: #007bff;
        opacity: 0.3;
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

// ★ (v20) buildDecorations を修正
function buildDecorations(state: EditorState): DecorationSet {
  console.log(`${logPrefix} buildDecorations()`); // (v21) ログ有効化
  const builder = new RangeSetBuilder<Decoration>();
  
  // (v10) state (EditorState) を渡す
  const blocks = parseTablesInDoc(state); 
  
  // ★ (v20) colWidthsField から幅マップを取得
  const widthsMap = state.field(colWidthsField);
  console.log(`${logPrefix} buildDecorations: WidthsMap from state:`, widthsMap); // (v22) ログ追加

  for (const block of blocks) {
    // ★ (v20) 現在のテーブルの幅配列を取得
    const widths = widthsMap[block.from] ?? null;
    if (widths) {
        console.log(`${logPrefix} buildDecorations: Found widths for block ${block.from}: [${widths.join(', ')}]`); // (v22) ログ追加
    }

    builder.add(
      block.from,
      block.to,
      Decoration.replace({
        // ★ (v20) TableWidget に幅配列を渡す
        widget: new TableWidget(block, widths)
      })
    );
  }
  return builder.finish();
}

// (v10 の tableDecoField)
export const tableDecoField = StateField.define<DecorationSet>({
  create(state) {
    console.log(`${logPrefix} tableDecoField.create()`); // (v21) ログ有効化
    return buildDecorations(state);
  },
  update(value, tr) {
    console.log(`${logPrefix} tableDecoField.update()`); // (v21) ログ有効化
    
    // ★ (v20) docChanged または列幅変更エフェクトがあった場合にデコレーションを再構築
    const needsUpdate = tr.docChanged || tr.effects.some(e => e.is(updateColWidthEffect));
    
    if (!needsUpdate) return value;
    
    console.log(`${logPrefix} tableDecoField.update(): doc or widths changed, rebuilding decorations.`); // (v21) ログ有効化
    // (v10) tr.state (新しい EditorState) を渡す
    return buildDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f)
});

// ---- Keymap ----

// (v10 の getActiveCellContext)
function getActiveCellContext(view: EditorView) {
  console.log(`${logPrefix} getActiveCellContext()`); // (v21) ログ有効化
  const sel = view.state.selection.main;
  const focused = view.hasFocus ? document.activeElement : null;
  
  if (!focused || (focused.tagName !== 'TH' && focused.tagName !== 'TD')) {
    console.log(`${logPrefix} getActiveCellContext: FAILED (No cell focused)`); // (v21) ログ有効化
    return null;
  }

  const container = getTableWidgetContainer(focused as HTMLElement);
  if (!container) {
    console.log(`${logPrefix} getActiveCellContext: FAILED (No container found)`); // (v21) ログ有効化
    return null;
  }

  const rc = getCellRC(focused as HTMLElement);
  if (!rc) {
    console.log(`${logPrefix} getActiveCellContext: FAILED (No RC found)`); // (v21) ログ有効化
    return null;
  }

  const from = parseInt(container.dataset.from!, 10);
  const colCount = parseInt(container.dataset.colCount!, 10);
  const rowCount = parseInt(container.dataset.rowCount!, 10);
  
  // (v8) view.state から最新の block を取得
  const block = parseTablesInDoc(view.state).find(b => b.from === from) ?? null;

  if (!block) {
    console.log(`${logPrefix} getActiveCellContext: FAILED (No block found at ${from})`); // (v21) ログ有効化
    return null;
  }
  
  console.log(`${logPrefix} getActiveCellContext: SUCCESS (row: ${rc.row}, col: ${rc.col})`); // (v21) ログ有効化
  return { ...rc, from, colCount, rowCount, block, el: focused as HTMLElement };
}

// (v10 の focusCell)
function focusCell(view: EditorView, from: number, row: number | null, col: number) {
  console.log(`${logPrefix} focusCell(from: ${from}, row: ${row}, col: ${col})`); // (v21) ログ有効化
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
        console.log(`${logPrefix} focusCell(async): Calling .focus() on target...`); // (v21) ログ有効化
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
  } else {
     console.warn(`${logPrefix} focusCell: Target cell (row: ${row}, col: ${col}) not found in container.`);
  }
}

// ★★★ (v19) cmdEnter 関数を削除 ★★★


// (v10 の Tab, Shift+Tab)
function cmdTab(view: EditorView): boolean {
  console.log(`${logPrefix} keymap: Tab`); // (v21) ログ有効化
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
    console.log(`${logPrefix} keymap: Tab (End of table)`); // (v21) ログ有効化
    return false; // デフォルトの Tab 動作 (テーブルから抜ける)
  }
  
  focusCell(view, from, nRow < 0 ? null : nRow, nCol);
  return true;
}
function cmdShiftTab(view: EditorView): boolean {
  console.log(`${logPrefix} keymap: Shift-Tab`); // (v21) ログ有効化
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
    console.log(`${logPrefix} keymap: Shift-Tab (Start of table)`); // (v21) ログ有効化
    return false; // デフォルトの Shift+Tab 動作
  }
  
  focusCell(view, from, nRow < 0 ? null : nRow, nCol);
  return true;
}

// (v10 の 矢印キー移動)
function moveHorizontal(dir: 'left' | 'right') {
  return (view: EditorView): boolean => {
    console.log(`${logPrefix} keymap: Arrow ${dir}`); // (v21) ログ有効化
    const ctx = getActiveCellContext(view);
    if (!ctx) return false;

    // TODO: カーソル位置が端かチェック
    
    const { from, row, col, colCount } = ctx;
    const nCol = clamp(col + (dir === 'left' ? -1 : 1), 0, colCount - 1);
    
    if (nCol === col) {
      console.log(`${logPrefix} keymap: Arrow ${dir} (At edge)`); // (v21) ログ有効化
      return false; // 端だった (デフォルトの矢印キー動作)
    }
    
    focusCell(view, from, row, nCol);
    return true;
  };
}
function moveVertical(dir: 'up' | 'down') {
  return (view: EditorView): boolean => {
    console.log(`${logPrefix} keymap: Arrow ${dir}`); // (v21) ログ有効化
    const ctx = getActiveCellContext(view);
    if (!ctx) return false;
    
    const { from, row, col, rowCount } = ctx;
    let nRow: number | null = row ?? -1; // -1 = header
    
    if (dir === 'up') {
      if (nRow === 0) nRow = null; // 1行目 -> ヘッダー
      else if (nRow > 0) nRow = nRow - 1; // 2行目以降
      else {
        console.log(`${logPrefix} keymap: Arrow ${dir} (At edge)`); // (v21) ログ有効化
        return false; // ヘッダー (null) より上には行けない
      }
    } else {
      if (nRow === null) nRow = 0; // ヘッダー -> 1行目
      else if (nRow < rowCount - 1) nRow = nRow + 1; // 最終行より前
      else {
        console.log(`${logPrefix} keymap: Arrow ${dir} (At edge)`); // (v21) ログ有効化
        return false; // 最終行
      }
    }
    
    focusCell(view, from, nRow, col);
    return true;
  };
}

// ★ (v22) PageUp/Down
function moveVerticalPage(dir: 'up' | 'down') {
    return (view: EditorView): boolean => {
        console.log(`${logPrefix} keymap: Page ${dir}`);
        const ctx = getActiveCellContext(view);
        if (!ctx) return false;
        
        const { from, col, row, rowCount } = ctx;
        let nRow: number | null;
        
        if (dir === 'up') {
            if (row === null) return true; // (v22) 既にヘッダーなら何もしない
            nRow = null; // ヘッダーへ
        } else {
            if (row === rowCount - 1) return true; // (v22) 既に最終行なら何もしない
            nRow = rowCount - 1; // 最終行へ
        }
        
        focusCell(view, from, nRow, col);
        return true;
    };
}

// ★ (v22) Home/End
function moveHorizontalPage(dir: 'home' | 'end') {
    return (view: EditorView): boolean => {
        console.log(`${logPrefix} keymap: ${dir}`);
        const ctx = getActiveCellContext(view);
        if (!ctx) return false;
        
        const { from, row, col, colCount } = ctx;
        let nCol: number;
        
        if (dir === 'home') {
            if (col === 0) return true; // (v22) 既に先頭列なら何もしない
            nCol = 0; // 最初の列へ
        } else {
            if (col === colCount - 1) return true; // (v22) 既に最終列なら何もしない
            nCol = colCount - 1; // 最後の列へ
        }
        
        focusCell(view, from, row, nCol);
        return true;
    };
}


// (v10)
function copySelectionTSV(view: EditorView): boolean {
  // TODO: 矩形選択
  console.log(`${logPrefix} keymap: Mod-c (Not implemented)`); // (v21) ログ有効化
  return false;
}

// (v19 の tableKeymap: Enter を削除)
export const tableKeymap = keymap.of([
  { key: 'ArrowLeft', run: moveHorizontal('left') },
  { key: 'ArrowRight', run: moveHorizontal('right') },
  { key: 'ArrowUp', run: moveVertical('up') },
  { key: 'ArrowDown', run: moveVertical('down') },
  { key: 'PageUp', run: moveVerticalPage('up') }, // ★ (v22) 追加
  { key: 'PageDown', run: moveVerticalPage('down') }, // ★ (v22) 追加
  { key: 'Home', run: moveHorizontalPage('home') }, // ★ (v22) 追加
  { key: 'End', run: moveHorizontalPage('end') }, // ★ (v22) 追加
  // { key: 'Enter', run: cmdEnter }, // ★ (v19) 削除
  { key: 'Tab', run: cmdTab },
  { key: 'Shift-Tab', run: cmdShiftTab }, 
  { key: 'Mod-c', run: copySelectionTSV },
]);

// ★ (v20) tableExtension に colWidthsField を追加
export const tableExtension = [
  colWidthsField, // ★ 列幅 state
  tableDecoField, // ★ デコレーション (Widget 描画)
];