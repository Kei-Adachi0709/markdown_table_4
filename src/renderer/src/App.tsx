import { useEffect } from 'react';
import Editor from './components/Editor';

export default function App() {
  useEffect(() => {
    // preloadの疎通確認（任意）
    if (window.appApi) {
      console.log('preload ping:', window.appApi.ping());
    }
  }, []);

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>Markdown Editor (CodeMirror 6 + GFM)</h1>
      </header>
      <main className="app-main">
        <Editor />
      </main>
    </div>
  );
}