const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

function getUpdateConfig(env = process.env) {
  const saved = JSON.parse(
    readFileSync(resolve(__dirname, "../update.config.json"), "utf8"),
  );
  const repository = env.PANXU_UPDATE_REPOSITORY?.trim() || saved.repository;
  if (
    repository !== null &&
    (typeof repository !== "string" ||
      !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]{1,100}$/.test(
        repository,
      ) ||
      repository.endsWith(".git"))
  ) {
    throw new Error(
      "PANXU_UPDATE_REPOSITORY 必须是公开 GitHub 仓库的 owner/repo，不是 URL。",
    );
  }
  const signed = env.PANXU_REQUIRE_SIGNING === "1";
  if (signed && !repository) throw new Error("正式签名构建必须配置更新仓库。");
  return { repository, signed };
}
module.exports = { getUpdateConfig };
