import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage, gfm } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
// 上記 oneDark を使わない場合は依存から外してOK（好みでテーマ調整）

// 後で実装するテーブル拡張（現在はスタブ）
import { tableExtension } from '../editor/extensions/TableExtension';

const initialMarkdown = `# Hello, Markdown (GFM)

- CodeMirror 6 ベースのエディタです
- GFM対応（チェックボックス、テーブル等）

## テーブル例（GFM）

| Name   | Age | City     |
|--------|-----|----------|
| Alice  | 24  | Tokyo    |
| Bob    | 31  | Osaka    |
| Carol  | 28  | Nagoya   |

- [ ] Todo 1
- [x] Todo 2
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
      // GFM（テーブル/タスクリスト/ストライクスルー等）
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [gfm()]
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const value = update.state.doc.toString();
          setDoc(value);
        }
      }),
      EditorView.theme(
        {
          '&': { height: '100%', fontSize: '14px' },
          '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' },
          '.cm-scroller': { overflow: 'auto' }
        },
        { dark: false }
      ),
      // 好みでOneDarkなどのテーマを追加可能
      // oneDark,
      // ここにカスタム・テーブル拡張を追加（現状はスタブ）
      tableExtension
    ],
    []
  );

  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      doc,
      extensions
    });

    const view = new EditorView({
      state,
      parent: hostRef.current
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [hostRef, extensions]);

  return (
    <div className="editor-container">
      <div className="editor-toolbar">
        <span>Length: {doc.length} chars</span>
      </div>
      <div className="editor-host" ref={hostRef} />
    </div>
  );
}