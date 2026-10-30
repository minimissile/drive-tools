import { BrowserWindow } from "electron";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AppError } from "../core/errors";
import {
  devSessionTitle,
  openDevSessionSchema,
  updateDevSessionSchema,
  type DevSession,
  type OpenDevSession,
} from "../shared/dev-sessions";

/** One backend and Chromium profile; only renderer identity and UI state differ. */
export class WorkbenchWindows {
  private entries = new Map<
    string,
    { window: BrowserWindow; info: DevSession }
  >();
  private request = new AsyncLocalStorage<BrowserWindow>();
  constructor(
    private notify: (sessions: DevSession[]) => void,
    private labeled = true,
  ) {}
  get size() {
    return this.entries.size;
  }
  list() {
    return [...this.entries.values()].map(({ info }) => ({ ...info }));
  }
  createInfo(input: OpenDevSession, restored?: DevSession): DevSession {
    const data = openDevSessionSchema.parse(input);
    return {
      ...data,
      id: restored?.id ?? randomUUID(),
      status:
        restored?.status ?? (data.mode === "automation" ? "paused" : "idle"),
      createdAt: restored?.createdAt ?? new Date().toISOString(),
    };
  }
  add(window: BrowserWindow, info: DevSession) {
    this.entries.set(info.id, { window, info });
    if (this.labeled) window.setTitle(devSessionTitle(info));
    if (this.labeled)
      window.on("page-title-updated", (event) => {
        event.preventDefault();
        window.setTitle(devSessionTitle(this.info(info.id)));
      });
    window.once("closed", () => {
      this.entries.delete(info.id);
      this.publish();
    });
    this.publish();
  }
  info(id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.window.isDestroyed())
      throw new AppError("WINDOW_CLOSED", "这个会话窗口已关闭。");
    return { ...entry.info };
  }
  fromSender(id: number) {
    return [...this.entries.values()].find(
      ({ window }) => !window.isDestroyed() && window.webContents.id === id,
    );
  }
  owner() {
    const owner = this.request.getStore();
    if (owner) {
      if (owner.isDestroyed())
        throw new AppError("WINDOW_CLOSED", "发起操作的窗口已关闭。");
      return owner;
    }
    const focused = BrowserWindow.getFocusedWindow();
    const entry =
      [...this.entries.values()].find(({ window }) => window === focused) ??
      this.entries.values().next().value;
    if (!entry) throw new AppError("WINDOW_CLOSED", "请先打开工作台窗口。");
    return entry.window;
  }
  run<T>(window: BrowserWindow, work: () => T): T {
    return this.request.run(window, work);
  }
  broadcast(channel: string, ...args: unknown[]) {
    for (const { window } of this.entries.values())
      if (!window.isDestroyed()) window.webContents.send(channel, ...args);
  }
  private publish() {
    this.broadcast("panxu:dev-sessions");
    this.notify(this.list());
  }
  update(input: unknown) {
    const { id, expectedStatus, ...patch } =
      updateDevSessionSchema.parse(input);
    const entry = this.entries.get(id);
    this.info(id);
    if (
      (expectedStatus && entry!.info.status !== expectedStatus) ||
      (entry!.info.status === "interrupted" &&
        patch.status &&
        patch.status !== "interrupted")
    )
      throw new AppError(
        "SESSION_CHANGED",
        "测试状态已改变，请保留当前窗口状态。",
      );
    if (
      entry!.info.mode === "development" &&
      patch.status &&
      patch.status !== "idle"
    )
      throw new AppError("SESSION_MODE", "开发窗口不记录自动化测试结果。");
    entry!.info = { ...entry!.info, ...patch };
    entry!.window.setTitle(devSessionTitle(entry!.info));
    this.publish();
    return this.info(id);
  }
  focus(id: string) {
    this.info(id);
    const window = this.entries.get(id)!.window;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  }
  close(id: string) {
    this.info(id);
    this.entries.get(id)!.window.close();
    return !this.entries.has(id);
  }
  get testing() {
    return this.list().some(
      (s) =>
        s.mode === "automation" && ["running", "paused"].includes(s.status),
    );
  }
}
