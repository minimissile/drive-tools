import { contextBridge, ipcRenderer } from "electron";
import type { AppApi, Result } from "../shared/types";
const api: AppApi = {
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
};
contextBridge.exposeInMainWorld("panxu", Object.freeze(api));
