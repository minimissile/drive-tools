import { createHash } from "node:crypto";
import { writeFile, rename } from "node:fs/promises";

/** Keep complete build generations in memory until an explicit application. */
export class DevUpdates {
  builds = new Map();
  revision = 0;
  latest;
  running;
  applying;
  applyError = "";
  constructor(names, changed) {
    this.changed = changed;
    for (const name of names)
      this.builds.set(name, { compiling: true, error: "", files: [] });
  }
  start(name) {
    this.builds.get(name).compiling = true;
    this.changed();
  }
  finish(name, result) {
    this.builds.set(name, {
      compiling: false,
      error: result.errors.length ? `${name} 编译失败，请查看开发终端。` : "",
      files: result.errors.length ? [] : result.outputFiles,
    });
    const builds = [...this.builds.values()];
    if (builds.every((build) => !build.compiling && !build.error)) {
      const files = builds.flatMap((build) => build.files);
      const hash = createHash("sha256");
      for (const file of files.filter((file) => !file.path.endsWith(".map")))
        hash.update(file.path).update(file.contents);
      const fingerprint = hash.digest("hex");
      if (fingerprint !== this.latest?.fingerprint) {
        this.latest = { revision: ++this.revision, fingerprint, files };
        this.applyError = "";
      }
    }
    this.changed();
  }
  get state() {
    const builds = [...this.builds.values()];
    return {
      revision: this.latest?.revision ?? 0,
      runningRevision: this.running?.revision ?? 0,
      pending:
        !!this.latest && this.latest.fingerprint !== this.running?.fingerprint,
      compiling: builds.some((build) => build.compiling),
      buildError: builds
        .map((build) => build.error)
        .filter(Boolean)
        .join("；"),
      applyError: this.applyError,
      applying: !!this.applying,
    };
  }
  begin() {
    const state = this.state;
    if (state.applying) throw new Error("正在应用后端更新，请稍候。");
    if (state.compiling) throw new Error("后端仍在编译，请完成后再应用。");
    if (state.buildError) throw new Error(state.buildError);
    if (!state.pending) throw new Error("当前没有待应用的后端更新。");
    // Capture this generation: later edits remain pending for the next click.
    this.applying = this.latest;
    this.applyError = "";
    this.changed();
    return this.applying;
  }
  cancel(reason) {
    this.applying = undefined;
    this.applyError = reason;
    this.changed();
  }
  async install() {
    const generation = this.applying;
    if (!generation) throw new Error("没有已确认的后端更新。");
    // The previous Electron process must have exited before replacing its files.
    for (const file of generation.files) {
      const temporary = `${file.path}.${process.pid}.tmp`;
      await writeFile(temporary, file.contents);
      await rename(temporary, file.path);
    }
    return generation.revision;
  }
  ready() {
    if (!this.applying) return;
    this.running = this.applying;
    this.applying = undefined;
    this.changed();
  }
}
