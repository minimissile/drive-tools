import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { devSessionRequest } from "./dev-session-client.mjs";

const { values } = parseArgs({
  options: {
    label: { type: "string" },
    session: { type: "string" },
    page: { type: "string" },
    list: { type: "boolean" },
    close: { type: "string" },
    focus: { type: "string" },
    finish: { type: "string", multiple: true },
  },
});

async function finishWindows(ids) {
  const targets = [...new Set(ids)];
  if (targets.some((id) => !id.trim() || id === "main"))
    throw new Error("收尾只接受本任务新建的专线窗口 ID，不能关闭主工作台。");
  const sessions = await devSessionRequest("dev.sessions");
  if (!sessions.some((item) => item.id === "main"))
    throw new Error("主工作台已关闭，请先恢复主窗口；本次未关闭任何专线窗口。");
  const opened = sessions.filter((item) => targets.includes(item.id));
  if (opened.some((item) => item.mode !== "development"))
    throw new Error("开发收尾不能关闭自动化窗口，请由对应测试会话管理。");

  // Reveal the acceptance window before closing only the explicitly recorded IDs.
  await devSessionRequest("dev.session.focus", { id: "main" });
  const closed = [];
  const failures = [];
  for (const item of opened) {
    try {
      await devSessionRequest("dev.session.close", { id: item.id });
      // Electron emits `closed` asynchronously after accepting the close request.
      const deadline = Date.now() + 3000;
      while (
        (await devSessionRequest("dev.sessions")).some((s) => s.id === item.id)
      ) {
        if (Date.now() >= deadline) throw new Error("窗口仍未关闭");
        await delay(100);
      }
      closed.push(item.id);
    } catch (error) {
      failures.push(`${item.id}: ${error.message}`);
    }
  }
  await devSessionRequest("dev.session.focus", { id: "main" });
  if (failures.length)
    throw new Error(
      `已切回主工作台，部分专线窗口未能关闭：${failures.join("；")}`,
    );
  return {
    closed,
    alreadyClosed: targets.filter(
      (id) => !opened.some((item) => item.id === id),
    ),
    focused: "main",
  };
}

try {
  if (
    [values.list, values.close, values.focus, values.finish].filter(Boolean)
      .length > 1
  )
    throw new Error("--list、--close、--focus 和 --finish 不能同时使用。");
  const value = values.finish
    ? await finishWindows(values.finish)
    : values.list
      ? await devSessionRequest("dev.sessions")
      : values.close
        ? await devSessionRequest("dev.session.close", { id: values.close })
        : values.focus
          ? await devSessionRequest("dev.session.focus", { id: values.focus })
          : await devSessionRequest("dev.session.open", {
              label: values.label || "开发工作台",
              session: values.session || process.env.CODEX_THREAD_ID || "",
              initialPage: values.page,
              mode: "development",
            });
  console.log(JSON.stringify(value, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
