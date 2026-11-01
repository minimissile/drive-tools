import type { Database } from "../../database";
import type {
  PageDiscoveryInput,
  PageDiscoveryPort,
  PageDiscoveryRun,
} from "../../../shared/zhidao-page-discovery";
import { AppError } from "../../errors";
import {
  createPageDiscovery,
  logDiscovery,
  readDiscoveryHttp,
  runPageDiscovery,
} from "./runner";

export class ZhidaoPageDiscovery {
  private run: PageDiscoveryRun | null;
  private active?: AbortController;
  private closed = false;
  constructor(
    private db: Database,
    private browser: PageDiscoveryPort | undefined,
    private changed: () => void,
  ) {
    const latestId = db.setting("zhidaoPages:latest", "");
    this.run = latestId
      ? db.setting<PageDiscoveryRun | null>(`zhidaoPages:run:${latestId}`, null)
      : null;
    if (this.run?.status === "running") {
      this.run.status = "paused";
      logDiscovery(
        this.run,
        "warning",
        "上次读取已中断，结果和进度保留，需手动继续。",
      );
      this.save();
    }
  }
  get isBusy() {
    return !!this.active || !!this.browser?.isOpen();
  }
  latest() {
    return this.run;
  }
  private require(id: string) {
    if (!this.run || this.run.id !== id)
      throw new AppError(
        "DISCOVERY_STALE",
        "当前检索记录已变化，请刷新后操作。",
      );
    return this.run;
  }
  private save() {
    if (this.closed || !this.run) return;
    this.db.setSetting(`zhidaoPages:run:${this.run.id}`, this.run);
    this.changed();
  }
  start(input: PageDiscoveryInput) {
    if (this.active)
      throw new AppError("DISCOVERY_BUSY", "正在检索，请先停止当前读取。");
    this.run = createPageDiscovery(input);
    this.db.setSetting("zhidaoPages:latest", this.run.id);
    this.save();
    this.launch();
    return this.run;
  }
  pause(id: string) {
    const run = this.require(id);
    this.active?.abort();
    run.status = "paused";
    logDiscovery(run, "warning", "已停止读取，结果和当前位置保留。");
    this.save();
    return run;
  }
  resume(id: string) {
    const run = this.require(id);
    if (this.active)
      throw new AppError("DISCOVERY_BUSY", "上一条读取正在结束，请稍后继续。");
    if (run.status !== "paused")
      throw new AppError("DISCOVERY_STATUS", "仅暂停的检索可以继续。");
    run.status = "running";
    this.launch();
    this.save();
    return run;
  }
  private launch() {
    const run = this.run!;
    const controller = new AbortController();
    this.active = controller;
    void runPageDiscovery(
      run,
      this.browser
        ? (url, signal) => this.browser!.read(url, signal)
        : readDiscoveryHttp,
      controller.signal,
      () => this.save(),
    )
      .catch((error) => {
        if (this.closed || controller.signal.aborted) return;
        run.status = "paused";
        logDiscovery(
          run,
          "warning",
          error instanceof Error ? error.message : "读取中断，已保留结果。",
        );
        this.save();
      })
      .finally(() => {
        if (this.active === controller) this.active = undefined;
      });
  }
  async openBrowser() {
    if (this.active)
      throw new AppError(
        "DISCOVERY_BUSY",
        "读取正在进行，请先停止后查看页面。",
      );
    if (!this.browser)
      throw new AppError(
        "DISCOVERY_BROWSER",
        "当前运行环境没有内置读取页面，请在源码桌面窗口中执行。",
      );
    const cursor =
      this.run?.status === "completed"
        ? Math.max(0, this.run.cursor - 1)
        : this.run?.cursor;
    await this.browser.open(
      cursor === undefined ? undefined : this.run?.jobs[cursor]?.url,
    );
  }
  exportRun(id: string) {
    return this.require(id);
  }
  close() {
    if (this.run?.status === "running") {
      this.run.status = "paused";
      logDiscovery(this.run, "warning", "服务已停止，检索进度保留。");
      this.save();
    }
    this.closed = true;
    this.active?.abort();
    this.browser?.close();
  }
}
