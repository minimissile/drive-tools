import { spawnSync } from "node:child_process";
if (process.platform !== "darwin")
  throw Error("公证凭据配置需要在 macOS 上进行。");
if (!process.stdin.isTTY)
  throw Error(
    "请在本机交互终端运行，Apple ID 和应用专用密码不要发到聊天或写入源码。",
  );
console.log(
  "将公证凭据保存在本机钥匙串 panxu-notary。请在此终端输入 Apple ID 和应用专用密码；不会写入项目配置或聊天。团队为 GJZ3P84DBM。",
);
const result = spawnSync(
  "xcrun",
  [
    "notarytool",
    "store-credentials",
    "panxu-notary",
    "--team-id",
    process.env.APPLE_TEAM_ID || "GJZ3P84DBM",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (result.status === 0)
  console.log(
    "公证凭据已验证并保存。后续 npm run release:mac 会自动使用 panxu-notary。",
  );
