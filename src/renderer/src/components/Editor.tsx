import React, { useEffect, useRef } from 'react';
import { EditorState, Prec } from '@codemirror/state';
import {
  EditorView,
  keymap,
  ViewUpdate,
  highlightActiveLine
} from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  defaultKeymap,
  history,
  historyKeymap
} from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';
import {
  highlightActiveLineGutter,
  lineNumbers
} from '@codemirror/gutter';
import { searchKeymap, search } from '@codemirror/search';
import { indentOnInput } from '@codemirror/language';
import { bracketMatching } from '@codemirror/matchbrackets';

// ★★★ ここが修正点 ★★★
// './extensions/...' (components フォルダ内) ではなく、
// '../editor/extensions/...' (components の外にある editor フォルダ内) を参照するように変更
import { tableExtension, tableKeymap } from '../editor/extensions/TableExtension';

// Editor コンポーネントが受け取るプロパティの型
interface EditorProps {
  initialValue: string;
  onChange: (value: string) => void;
}

/**
 * CodeMirror 6 (GFM + カスタムテーブル) を搭載した React エディタコンポーネント
 */
const Editor: React.FC<EditorProps> = ({ initialValue, onChange }) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // エディタの初期化 (マウント時に一度だけ実行)
  useEffect(() => {
    if (!editorRef.current) return;

    // 拡張機能の配列
    const extensions = [
      // --- 基本機能 ---
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      autocompletion(),
      search(),

      // --- Markdown (GFM) ---
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        addKeymap: true // GFM デフォルトのキーマップ (リストの自動継続など)
      }),

      // ★★★ テーブル拡張機能 ★★★
      tableExtension, // 1. テーブルの描画 (Widget)
      Prec.high(tableKeymap), // 2. テーブルのキー操作 (Enter, Tab, 矢印)

      // --- 変更検知リスナー ---
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          const newValue = update.state.doc.toString();
          // 外部のコンポーネント (App.tsx など) に変更を通知
          onChange(newValue);
        }
      })
    ];

    // エディタの初期状態を作成
    const startState = EditorState.create({
      doc: initialValue,
      extensions: extensions
    });

    // EditorView (エディタ本体) を作成し、DOMにアタッチ
    const view = new EditorView({
      state: startState,
      parent: editorRef.current
    });

    // view を ref に保存 (後で使うため)
    viewRef.current = view;

    // コンポーネントがアンマウントされる時に EditorView を破棄
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // onChange が変更された場合 (通常は関数定義が変わらない) に備えて依存配列に含める
  }, [editorRef, onChange]);

  // 外部から initialValue が変更された場合に対応
  // (例: App.tsx でファイルを開き直したなど)
  useEffect(() => {
    if (
      viewRef.current &&
      initialValue !== viewRef.current.state.doc.toString()
    ) {
      viewRef.current.dispatch({
        changes: {
          from: 0,
          to: viewRef.current.state.doc.length,
          insert: initialValue
        }
      });
    }
  }, [initialValue]);

  // エディタをマウントするコンテナ
  return (
    <div
      ref={editorRef}
      className="editor-container"
      style={{ height: '100%', width: '100%', overflow: 'auto' }}
    />
  );
};

export default Editor;