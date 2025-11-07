import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage, gfm } from '@codemirror/lang-markdown';
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
        extensions: [gfm()]
      }),

      // Editor の変更を外へ反映
      EditorView.updateListener.of((update) => {
        if (update.docChanged) setDoc(update.state.doc.toString());
      }),

      // oneDark,
      tableExtension,
      tableKeymap // ← カスタムキーバインド
    ],
    []
  );

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

  return (
    <div className="editor-container">
      <div className="editor-toolbar">
        <span>Length: {doc.length} chars</span>
      </div>
      <div className="editor-host" ref={hostRef} />
    </div>
  );
}