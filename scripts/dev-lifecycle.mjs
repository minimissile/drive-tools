import { realpath } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

/** One supervisor per checkout, independent of port and temporary database. */
export async function acquireDevLock(root, onCompromised) {
  const canonicalRoot = await realpath(root);
  try {
    return await lockfile.lock(canonicalRoot, {
      lockfilePath: join(canonicalRoot, ".panxu-dev.lock"),
      stale: 10000,
      update: 2000,
      retries: 0,
      ...(onCompromised ? { onCompromised } : {}),
    });
  } catch (error) {
    if (error.code === "ELOCKED")
      throw new Error(
        "当前项目已有开发服务运行，请复用现有源码窗口；更换端口或测试数据目录不会启动第二个实例。",
      );
    throw error;
  }
}

/** Only terminate a child owned by this supervisor, and wait before releasing ownership. */
export async function stopDevChild(child, graceMs = 5000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise((resolve, reject) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
    child.kill("SIGTERM");
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      timer = setTimeout(() => {
        child.removeListener("exit", done);
        reject(new Error("开发子进程尚未退出，未释放项目启动锁。"));
      }, 2000);
    }, graceMs);
  });
}
