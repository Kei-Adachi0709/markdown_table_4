import React, { useEffect, useRef, useState } from 'react';
import { EditorState, Prec } from '@codemirror/state'; // ★ Prec をインポート
import { EditorView, keymap } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap } from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';

// ★ インポートを追加
import { tableExtension, tableKeymap } from './extensions/TableExtension';

// ... (他のインポート) ...

// ... (EditorProps や interface) ...

const Editor: React.FC<EditorProps> = ({ initialValue, onChange }) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // ... (他の useEffect やロジック) ...

  useEffect(() => {
    if (!editorRef.current) return;

    // ★ 既存の extensions 配列を定義している場所を探す
    // (これは一例です。実際の構造に合わせてください)
    const extensions = [
      // ... (既存の history(), highlightActiveLineGutter() など ...)
      keymap.of(defaultKeymap),
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        addKeymap: true
      }),
      autocompletion(),
      // ... (既存の theme など ...)

      // ★ ここにテーブル拡張機能を追加します
      tableExtension,       // テーブルの描画 (Widget)
      Prec.high(tableKeymap)  // テーブルのキー操作 (Enter, Tab, 矢印)

      // ... (既存の updateListener など ...)
    ];

    const startState = EditorState.create({
      doc: initialValue,
      extensions: extensions // ★ 修正済みの extensions を渡す
    });

    const view = new EditorView({
      state: startState,
      parent: editorRef.current
    });

    viewRef.current = view;

    return () => {
      view.destroy();
    };
  }, [editorRef, initialValue, onChange]); // 依存配列は適宜調整してください

  return <div ref={editorRef} className="editor-container" />;
};

export default Editor;