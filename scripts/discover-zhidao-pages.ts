#!/usr/bin/env node
/** Read-only CLI. Uses the same runner/parser as the workbench, with no account, model or publishing calls. */
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createPageDiscovery,
  readDiscoveryHttp,
  runPageDiscovery,
} from "../core/zhidao/page-discovery/runner";
import { exportDiscoveredPages } from "../core/zhidao/page-discovery/export";

const { values } = parseArgs({
  options: {
    keyword: { type: "string", multiple: true },
    url: { type: "string", multiple: true },
    pages: { type: "string", default: "2" },
    limit: { type: "string", default: "50" },
    interval: { type: "string", default: "2000" },
    out: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`用法：node --import tsx scripts/discover-zhidao-pages.ts --keyword '小提琴教程' --pages 2 --limit 50 --out /tmp/zhidao-pages.json
关键词和 --url 可重复传入；支持同时检索关键词和检查指定问题/回答页。--interval 单位毫秒，最少1000。
结果仅包含确认在回答正文中出现网盘链接的回答页。HTTP检索遇到安全验证时暂停，不绕过验证。
指定 --out 保存JSON或CSV；不指定时JSON输出到stdout，读取日志输出到stderr。`);
} else {
  const run = createPageDiscovery({
    keywords: values.keyword || [],
    urls: values.url || [],
    pages: Number(values.pages),
    limit: Number(values.limit),
    intervalMs: Number(values.interval),
  });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  let last = "";
  try {
    await runPageDiscovery(run, readDiscoveryHttp, controller.signal, () => {
      const message = run.logs.at(-1);
      const key = JSON.stringify(message);
      if (message && key !== last) {
        last = key;
        process.stderr.write(`[${message.kind}] ${message.message}\n`);
      }
    });
  } catch (e) {
    run.status = "paused";
    run.message = controller.signal.aborted
      ? "已停止读取，部分结果保留。"
      : e instanceof Error
        ? e.message
        : "检索中断";
    process.stderr.write(`${run.message}\n`);
  }
  if (values.out) {
    const output = resolve(values.out);
    await writeFile(
      output,
      exportDiscoveredPages(run, output.endsWith(".csv") ? "csv" : "json"),
    );
    process.stderr.write(`已保存 ${run.items.length} 个回答页：${output}\n`);
  } else process.stdout.write(exportDiscoveredPages(run, "json"));
  if (run.status === "paused") process.exitCode = 2;
}
