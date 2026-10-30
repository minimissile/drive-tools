import { contextBridge, ipcRenderer } from "electron";
import type { AppApi, Result } from "../shared/types";
const api: AppApi = {
  windowId: process.argv.find((arg) => arg.startsWith("--panxu-window-id="))?.slice("--panxu-window-id=".length),
  initialPage: process.argv.find((arg) => arg.startsWith("--panxu-initial-page="))?.slice("--panxu-initial-page=".length),
  onDevSessionsChanged(callback) {
    const handler = () => callback();
    ipcRenderer.on("panxu:dev-sessions", handler);
    return () => ipcRenderer.removeListener("panxu:dev-sessions", handler);
  },
  async invoke<T>(method: string, args?: unknown): Promise<T> {
    const result: Result<T> = await ipcRenderer.invoke("panxu:invoke", {
      method,
      args,
    });
    if (!result.ok) {
      const error = new Error(result.error?.message ?? "操作失败");
      Object.assign(error, { code: result.error?.code });
      throw error;
    }
    return result.value as T;
  },
  onChanged(callback) {
    const handler = () => callback();
    ipcRenderer.on("panxu:changed", handler);
    return () => ipcRenderer.removeListener("panxu:changed", handler);
  },
  onUpdateChanged(callback) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: import("../shared/updates").UpdateState,
    ) => callback(state);
    ipcRenderer.on("panxu:update", handler);
    return () => ipcRenderer.removeListener("panxu:update", handler);
  },
};
contextBridge.exposeInMainWorld("panxu", Object.freeze(api));
