import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const devRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function devConnection() {
  let info;
  try {
    info = JSON.parse(
      await readFile(join(devRoot, ".panxu-dev-session.json"), "utf8"),
    );
  } catch {
    throw new Error(
      "未找到共享开发后台，请先运行或重启 npm run dev。不要另外启动 Electron。",
    );
  }
  const url = new URL(info.url);
  if (
    (await realpath(info.root)) !== (await realpath(devRoot)) ||
    url.hostname !== "127.0.0.1" ||
    url.protocol !== "http:" ||
    !/^\d+$/.test(String(info.cdpPort))
  )
    throw new Error("开发会话连接信息不属于当前源码，请重新启动 npm run dev。");
  const identity = await fetch(`${url.origin}/__panxu_dev`, {
    signal: AbortSignal.timeout(5000),
  }).then((r) => r.json());
  if ((await realpath(identity.root)) !== (await realpath(devRoot)))
    throw new Error("开发服务源码目录不匹配。");
  return info;
}
export async function devSessionRequest(action, args, connection) {
  const info = connection ?? (await devConnection());
  const response = await fetch(`${info.url}/__panxu_dev/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${info.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, args }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok && response.status !== 400)
    throw new Error("开发会话连接已失效，请检查 npm run dev 的运行状态。");
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result.value;
}
