import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, access, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../core/errors";
import type { QuarkNativeSign } from "../core/providers/quark-passphrase";

const unavailable = () =>
  new AppError(
    "QUARK_SIGN_UNAVAILABLE",
    "未能调用本机夸克官方组件。请安装或更新夸克桌面客户端后重试获取口令；分享链接已保留。",
  );
async function executable() {
  if (process.platform !== "darwin")
    throw new AppError(
      "QUARK_SIGN_UNAVAILABLE",
      "当前仅支持 macOS 夸克官方桌面组件获取口令；分享链接已保留。",
    );
  for (const root of ["/Applications", join(homedir(), "Applications")]) {
    const path = join(root, "Quark.app/Contents/MacOS/Quark");
    try {
      await access(path);
      return path;
    } catch {
      /* Try the user application directory. */
    }
  }
  throw unavailable();
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function connectInspector(port: number, child: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) throw unavailable();
    try {
      const rows = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(650),
      }).then((r) => r.json());
      const target =
        Array.isArray(rows) && rows.find((row) => row.type === "node");
      if (target?.webSocketDebuggerUrl) {
        const url = new URL(target.webSocketDebuggerUrl);
        if (
          url.protocol === "ws:" &&
          url.hostname === "127.0.0.1" &&
          Number(url.port) === port
        )
          return url.href;
      }
    } catch {
      /* Runtime has not opened its local inspector yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw unavailable();
}
async function signer(endpoint: string) {
  const ws = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(unavailable());
    }, 5000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(unavailable());
      },
      { once: true },
    );
  });
  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve(value: any): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(unavailable());
    }
    pending.clear();
  };
  ws.addEventListener("close", fail);
  ws.addEventListener("error", fail);
  ws.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)),
        item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      message.error
        ? item.reject(
            new AppError(
              "QUARK_SIGN_UNAVAILABLE",
              unavailable().message,
              false,
              {
                nativeCode: message.error.code,
                nativeReason: String(message.error.message).slice(0, 160),
              },
            ),
          )
        : item.resolve(message.result);
    } catch {
      fail();
    }
  });
  const request = (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<any> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => {
          pending.delete(id);
          reject(unavailable());
        }, 7000),
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  let taskId = 0;
  const sign: QuarkNativeSign = async (value) => {
    if (value.length > 32_000) throw unavailable();
    const argument = JSON.stringify({ number: 14100, value_to_sign: value });
    const id = ++taskId;
    // Native signing is asynchronous. Keep its task rooted in the official VM
    // and poll plain data: CDP's awaitPromise can report "Promise was collected"
    // even though the native bridge is still completing the request.
    const expression = `(()=>{const task={id:${id},status:'pending'};globalThis.__panxuSignerTask=task;task.promise=Promise.resolve(globalThis.quantum.wsg.sign(${argument})).then(v=>{task.sign=v?.sign;task.status='ready'},()=>{task.status='failed'});return true;})()`;
    const started = await request("Runtime.evaluate", {
      returnByValue: true,
      expression,
    });
    if (started.exceptionDetails || started.result?.value !== true)
      throw unavailable();
    try {
      const deadline = Date.now() + 7000;
      while (ws.readyState === WebSocket.OPEN && Date.now() < deadline) {
        const response = await request("Runtime.evaluate", {
          returnByValue: true,
          expression:
            "(()=>{const t=globalThis.__panxuSignerTask;return t?{id:t.id,status:t.status,sign:t.sign}:null})()",
        });
        const task = response.result?.value;
        if (
          response.exceptionDetails ||
          task?.id !== id ||
          task.status === "failed"
        )
          throw unavailable();
        if (task.status === "ready") {
          if (
            typeof task.sign !== "string" ||
            !task.sign ||
            task.sign.length > 4096
          )
            throw unavailable();
          return task.sign;
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      throw unavailable();
    } finally {
      if (ws.readyState === WebSocket.OPEN)
        await request("Runtime.evaluate", {
          expression: `if(globalThis.__panxuSignerTask?.id===${id})delete globalThis.__panxuSignerTask`,
        }).catch(() => {});
    }
  };
  // The inspector opens before the official SDK finishes bootstrapping. Importing
  // its native module during that interval can lose the Promise's VM context.
  // Wait for the client's own initialization before calling the native API.
  try {
    const deadline = Date.now() + 8000;
    let ready = false;
    while (ws.readyState === WebSocket.OPEN && Date.now() < deadline) {
      const response = await request("Runtime.evaluate", {
        returnByValue: true,
        expression: "typeof globalThis.quantum?.wsg?.sign === 'function'",
      });
      if (response.result?.value === true) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (!ready) throw unavailable();
  } catch (error) {
    ws.close();
    throw error;
  }
  return {
    sign,
    isOpen: () => ws.readyState === WebSocket.OPEN,
    close: () => {
      fail();
      ws.close();
    },
  };
}

interface NativeRuntime {
  child: ChildProcess;
  profile: string;
  exited: Promise<void>;
  connection?: Awaited<ReturnType<typeof signer>>;
  disposing?: Promise<void>;
}

/** One anonymous official desktop runtime, reused until this workbench backend exits. */
export class QuarkShareSigner {
  private active = new Set<NativeRuntime>();
  private runtime?: NativeRuntime;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private onExit = () => this.close();
  constructor() {
    process.once("exit", this.onExit);
  }
  close() {
    this.closed = true;
    process.removeListener("exit", this.onExit);
    this.runtime = undefined;
    for (const runtime of this.active) void this.dispose(runtime);
  }
  private stop(child: ChildProcess, signal: NodeJS.Signals) {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* Only the process group created by this instance. */
    }
  }
  private dispose(runtime: NativeRuntime) {
    return (runtime.disposing ??= (async () => {
      runtime.connection?.close();
      this.stop(runtime.child, "SIGTERM");
      await Promise.race([
        runtime.exited,
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
      this.stop(runtime.child, "SIGKILL");
      this.active.delete(runtime);
      await rm(runtime.profile, { recursive: true, force: true }).catch(
        () => {},
      );
    })());
  }
  private async open() {
    const binary = await executable();
    const profile = await mkdtemp(join(tmpdir(), "panxu-quark-sign-"));
    let runtime: NativeRuntime | undefined;
    try {
      const port = await freePort();
      let cloudPort = await freePort();
      while (cloudPort === port) cloudPort = await freePort();
      if (this.closed) throw unavailable();
      const child = spawn(
        binary,
        [
          "--headless",
          "--no-first-run",
          "--disable-background-networking",
          `--user-data-dir=${profile}`,
          "--quantum-develop-mode",
          `--quantum-node-inspect-ports=quark-agent=${port},quark-cloud-drive=${cloudPort}`,
        ],
        { detached: true, stdio: "ignore" },
      );
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
      runtime = { child, profile, exited };
      this.active.add(runtime);
      const endpoint = await connectInspector(port, child);
      runtime.connection = await signer(endpoint);
      if (this.closed) throw unavailable();
      return runtime;
    } catch (error) {
      if (runtime) await this.dispose(runtime);
      else await rm(profile, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  async withSigner<T>(
    action: (sign: QuarkNativeSign) => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.closed) throw unavailable();
      if (
        this.runtime &&
        (!this.runtime.connection?.isOpen() ||
          this.runtime.child.exitCode !== null ||
          this.runtime.child.signalCode)
      ) {
        await this.dispose(this.runtime);
        this.runtime = undefined;
      }
      const runtime = (this.runtime ??= await this.open());
      return await action(runtime.connection!.sign);
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === "QUARK_SIGN_UNAVAILABLE" &&
        this.runtime
      ) {
        // A manual retry may open a fresh SDK, but never replay the caller's
        // remote operation automatically after an uncertain result.
        await this.dispose(this.runtime);
        this.runtime = undefined;
      }
      throw error;
    } finally {
      release();
    }
  }
}
