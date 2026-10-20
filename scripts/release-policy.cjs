const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

function getReleasePolicy() {
  const { platforms } = JSON.parse(
    readFileSync(resolve(__dirname, "../release.config.json"), "utf8"),
  );
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, "../package.json"), "utf8"),
  );
  if (
    !Array.isArray(platforms) ||
    !platforms.length ||
    new Set(platforms).size !== platforms.length ||
    platforms.some((p) => !["mac", "win"].includes(p))
  )
    throw Error("release.config.json 必须声明不重复的 mac/win 发行平台。");
  return Object.fromEntries(
    platforms.map((platform) => {
      const arches = [
        ...new Set(pkg.build[platform].target.flatMap((target) => target.arch)),
      ];
      const supported = platform === "mac" ? "arm64" : "x64";
      if (!arches.length || arches.some((arch) => arch !== supported))
        throw Error(`当前 ${platform} 仅支持 ${supported} 发行。`);
      return [platform, arches];
    }),
  );
}
module.exports = { getReleasePolicy };
