import { contextBridge } from 'electron';

// ここで必要なIPCや安全なAPIを公開できます。
// ベースではダミーのエクスポートのみ。
contextBridge.exposeInMainWorld('appApi', {
  ping: () => 'pong'
});

declare global {
  interface Window {
    appApi: {
      ping: () => string;
    };
  }
}