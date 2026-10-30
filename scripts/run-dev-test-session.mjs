import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withDevTestSession } from "./dev-test-session.mjs";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    label: { type: "string" },
    session: { type: "string" },
    page: { type: "string" },
    close: { type: "boolean", default: false },
  },
});
try {
  if (!values.module || !values.label)
    throw new Error(
      "请传入 --module 测试模块路径 和 --label 测试内容。模块需导出 async run({ page, checkpoint, windowId })。",
    );
  const module = await import(pathToFileURL(resolve(values.module)).href);
  const result = await withDevTestSession(
    {
      label: values.label,
      session: values.session || process.env.CODEX_THREAD_ID || "",
      initialPage: values.page,
      close: values.close,
    },
    module.run,
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
