import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { history, historyKeymap } from '@codemirror/commands';

// 修正 1: gfm のインポート元を変更
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { gfm } from '@lezer/markdown'; // <-- @codemirror/lang-markdown から削除し、こちらからインポート

import { languages } from '@codemirror/language-data';
import { basicSetup } from 'codemirror';
// import { oneDark } from '@codemirror/theme-one-dark';
import { tableExtension, tableKeymap } from '../editor/extensions/TableExtension';

const initialMarkdown = `# Table demo

| Name   | Age | City     |
|--------|-----|----------|
| Alice  | 24  | Tokyo    |
| Bob    | 31  | Osaka    |
| Carol  | 28  | Nagoya   |

---
# 資産クラス

| 資産クラス | :--- | 割合 | 変更済みか | |
|:---|:---|:---|:---|:---|
| **SB1・V・S&P500インデックス・ファンド** | | 25% | 〇 | |
| **SB1・先進国株式インデックス・ファンド** | | 65% | 〇 | |
| **SB1・新興国株式インデックス・ファンド** | | 6% | 〇 | |
| **SB1・iシェアーズ・TOPIXインデックス・ファンド** | | 4% | 〇 | |
`;

export default function Editor() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [doc, setDoc] = useState<string>(initialMarkdown);

  const extensions = useMemo<Extension[]>(
    () => [
      basicSetup,
      history(),
      keymap.of(historyKeymap),

      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        // 修正 2: gfm() ではなく、gfm オブジェクトを渡す
        extensions: [gfm]
      }),

      // Editor の変更を外へ反映 (CM -> React)
      EditorView.updateListener.of((update) => {
        if (update.docChanged) setDoc(update.state.doc.toString());
      }),

      // oneDark,
      tableExtension,
      tableKeymap // ← カスタムキーバインド
    ],
    []
  );

  // エディタの初期化
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({ doc, extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [hostRef, extensions]);

  // 修正 3: React の state が変更されたら CM に反映する (React -> CM)
  // (これが無いと、将来的にファイルを開き直した際などにエディタが更新されない)
  useEffect(() => {
    if (viewRef.current && doc !== viewRef.current.state.doc.toString()) {
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: doc }
      });
    }
  }, [doc]);


  return (
    <div className="editor-container">
      <div className="editor-toolbar">
        <span>Length: {doc.length} chars</span>
      </div>
      <div className="editor-host" ref={hostRef} />
    </div>
  );
}