import { parseArgs } from "node:util";
import { devSessionRequest } from "./dev-session-client.mjs";

const { values } = parseArgs({
  options: {
    label: { type: "string" },
    session: { type: "string" },
    page: { type: "string" },
    list: { type: "boolean" },
    close: { type: "string" },
    focus: { type: "string" },
  },
});
try {
  const value = values.list
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
