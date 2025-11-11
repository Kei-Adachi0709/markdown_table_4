import React, { useEffect, useRef } from 'react';
import { EditorState, Prec } from '@codemirror/state';
import {
  EditorView,
  keymap,
  ViewUpdate
} from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  defaultKeymap,
  history,
  historyKeymap
} from '@codemirror/commands';

// ★★★ 修正: テーブル以外の追加機能をすべて削除 ★★★
// import { autocompletion } from '@codemirror/autocomplete';
// import { searchKeymap, search } from '@codemirror/search';
// import { indentOnInput } from '@codemirror/language';
// import { bracketMatching } from '@codemirror/matchbrackets';
// import { highlightActiveLine } from '@codemirror/view';

// '../editor/...' のパス（修正済み）
import { tableExtension, tableKeymap } from '../editor/extensions/TableExtension';

// Editor コンポーネントが受け取るプロパティの型
interface EditorProps {
  initialValue: string;
  onChange: (value: string) => void;
}

/**
 * CodeMirror 6 (GFM + カスタムテーブル) を搭載した React エディタコンポーネント
 * [最小構成版]
 */
 // ★★★ 修正 (v2): onChange にデフォルト値を追加 ★★★
const Editor: React.FC<EditorProps> = ({ initialValue, onChange = () => {} }) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // エディタの初期化 (マウント時に一度だけ実行)
  useEffect(() => {
    if (!editorRef.current) return;

    // 拡張機能の配列 (最小構成)
    const extensions = [
      // --- 基本機能 ---
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]), // ★ searchKeymap を削除

      // ★★★ 削除: 以下の追加機能をすべて削除 ★★★
      // indentOnInput(),
      // bracketMatching(),
      // highlightActiveLine(),
      // autocompletion(),
      // search(),

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
          onChange(newValue); // ★ デフォルト値があるのでエラーにならない
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

  // (中略: 外部からの initialValue が変更された場合の useEffect は変更なし)
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