const { getUpdateConfig } = require("./scripts/update-config.cjs");
const { repository, signed } = getUpdateConfig();
const base = require("./package.json").build;
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const version = require("./package.json").version;
const notes = join(__dirname, "docs", "releases", `${version}.md`);
if (
  signed &&
  process.platform === "win32" &&
  !process.env.PANXU_WINDOWS_PUBLISHER
) {
  throw new Error(
    "正式 Windows 构建必须配置证书主体 PANXU_WINDOWS_PUBLISHER。",
  );
}
module.exports = {
  ...base,
  forceCodeSigning: signed,
  electronUpdaterCompatibility: ">=2.16",
  releaseInfo: {
    releaseName: `盘序 ${version}`,
    ...(existsSync(notes) ? { releaseNotes: readFileSync(notes, "utf8") } : {}),
  },
  publish: repository
    ? [
        {
          provider: "github",
          owner: repository.split("/")[0],
          repo: repository.split("/")[1],
          private: false,
          releaseType: "draft",
          vPrefixedTagName: true,
          timeout: 30000,
        },
      ]
    : null,
  mac: {
    ...base.mac,
    // Match macOS .lproj names, including the Chinese grammar variants.
    electronLanguages: [
      "zh_CN",
      "zh_CN_FEMININE",
      "zh_CN_MASCULINE",
      "zh_CN_NEUTER",
    ],
    extraResources: [
      {
        from: "build/pansou",
        to: "pansou",
        filter: ["darwin-${arch}/**", "LICENSE.txt", "THIRD_PARTY_NOTICES.txt"],
      },
    ],
    ...(signed ? {} : { identity: null }),
    hardenedRuntime: true,
    // Non-executable assets remain covered by the app's resource seal. Signing
    // them separately adds timestamp requests without protecting executable code.
    signIgnore: ["\\.(?:pak|ttf|otf|woff2?|icns|png)$"],
    notarize: signed,
  },
  win: {
    ...base.win,
    // Windows locale .pak names use hyphens instead of underscores.
    electronLanguages: ["zh-CN"],
    extraResources: [
      {
        from: "build/pansou",
        to: "pansou",
        filter: ["win32-${arch}/**", "LICENSE.txt", "THIRD_PARTY_NOTICES.txt"],
      },
    ],
    verifyUpdateCodeSignature: true,
    ...(process.env.PANXU_WINDOWS_PUBLISHER
      ? {
          signtoolOptions: {
            publisherName: process.env.PANXU_WINDOWS_PUBLISHER,
          },
        }
      : {}),
  },
};
