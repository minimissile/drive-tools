import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import lockfile from "proper-lockfile";
import { load } from "js-yaml";
import policy from "./release-policy.cjs";
import updateConfig from "./update-config.cjs";
import {
  assertCleanReleaseSource,
  canReuseReleaseBuild,
  commitReleaseSource,
  pushReleaseSource,
  releaseGitHubContext,
  remoteReleaseCommit,
} from "./release-git.mjs";
import { publishRelease } from "./release-publication.mjs";
import {
  canonicalDirectory,
  macBaselinePaths,
  verifyMacBaseline,
} from "./release-baseline.mjs";
import {
  applyReleaseVersion,
  nextReleaseVersion,
  readVersionFiles,
  writeReleaseFileAtomic,
} from "./release-version.mjs";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    platform: { type: "string" },
    arch: { type: "string" },
    "from-dir": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    "draft-only": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: false,
});
if (values.help) {
  console.log(`用法：
  npm run release:full          自动增加次版本，例如 0.0.4 → 0.1.0
  npm run release:differential  自动增加补丁版本，例如 0.0.4 → 0.0.5
  追加 --dry-run 只显示计划，不升版、不写文件、不联网、不打包。

自动同步版本、生成说明、提交当前源码、签名公证打包、推送分支和标签、上传并正式发布。
差分基线自动使用升版前的版本；优先读取本地发行包，缺失时从配置的 GitHub Release 下载。
可选 --platform mac|win、--arch arm64|x64、--from-dir <旧包目录>。
失败后再点同一命令会续跑同一版本；成功后下次点击再升版。
Git 提交包含当前工作区全部未忽略改动；正式发布后客户端即可检查到更新。不自动运行测试。
已有打包完成但未发布的版本自动续发，不重复升版。release:draft 仅为续跑到草稿的可选兼容入口。
固定版本构建仍可使用 release:mac / release:win。`);
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
process.chdir(root);
const evidence = join(root, "release-evidence");
const statePath = join(evidence, "auto-release.json");
const mode = values.mode ?? (values.resume ? readState()?.mode : undefined);
assert.ok(
  ["full", "differential"].includes(mode),
  "请选择 release:full 或 release:differential。",
);
assert.ok(
  mode === "differential" || !values["from-dir"],
  "--from-dir 仅用于差分命令。",
);
const platform =
  values.platform ?? { darwin: "mac", win32: "win" }[process.platform];
const targets = policy.getReleasePolicy();
assert.ok(targets[platform], "当前系统或平台未在 release.config.json 中启用。");
assert.equal(
  Object.keys(targets).length,
  1,
  "自动升版命令目前一次交付一个平台；多平台请先统一版本，再用 release:mac / release:win。",
);
const arch = values.arch ?? targets[platform][0];
assert.ok(targets[platform].includes(arch), "发行计划不支持指定架构。");
assert.ok(
  mode !== "differential" || (platform === "mac" && arch === "arm64"),
  "差分准备目前仅支持 macOS ARM64。",
);
function readState() {
  if (!existsSync(statePath)) return null;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.ok(
    [1, 2].includes(state.format) &&
      ["pending", "complete"].includes(state.status),
    "自动发布记录无效，请保留该记录后排查。",
  );
  assert.equal(
    nextReleaseVersion(state.baseVersion, state.mode),
    state.targetVersion,
    "自动发布记录的版本关系无效。",
  );
  return state;
}

async function releasePlan() {
  const current = await readVersionFiles(root);
  const pending = readState();
  if (
    pending &&
    (pending.status === "pending" ||
      (pending.format === 1 && !pending.publishedAt) ||
      values.resume)
  ) {
    assert.ok(
      pending.mode === mode &&
        pending.platform === platform &&
        pending.arch === arch,
      `存在未完成的 ${pending.mode} ${pending.targetVersion}，请再次运行对应命令继续。`,
    );
    for (const version of [
      current.version,
      current.lockJson.version,
      current.lockJson.packages?.[""]?.version,
    ])
      assert.ok(
        [pending.baseVersion, pending.targetVersion].includes(version),
        "版本文件已被修改为其他版本，请保留未完成记录后排查。",
      );
    if (process.env.PANXU_RELEASE_DIR)
      assert.equal(
        canonicalDirectory(resolve(process.env.PANXU_RELEASE_DIR)),
        canonicalDirectory(pending.output),
        "重试不能更换输出目录。",
      );
    return {
      ...pending,
      resumed: true,
      legacyBuild: pending.format === 1 && pending.status === "complete",
    };
  }
  assert.ok(
    !values.resume,
    "没有可续跑的发行任务，请直接点击 release:full 或 release:differential。",
  );
  assert.equal(
    current.lockJson.version,
    current.version,
    "锁文件版本与 package.json 不一致。",
  );
  assert.equal(
    current.lockJson.packages?.[""]?.version,
    current.version,
    "锁文件根包版本不一致。",
  );
  const targetVersion = nextReleaseVersion(current.version, mode);
  return {
    format: 2,
    status: "pending",
    mode,
    platform,
    arch,
    baseVersion: current.version,
    targetVersion,
    output: resolve(
      process.env.PANXU_RELEASE_DIR || `release/${targetVersion}`,
    ),
    phase: "准备基线",
    startedAt: new Date().toISOString(),
  };
}

if (values["dry-run"]) {
  const plan = await releasePlan();
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        ...plan,
        stages: [
          ...(mode === "differential"
            ? [`查找并校验 ${plan.baseVersion} 基线，缺失时下载同版本官方附件`]
            : []),
          "同步两份版本文件，生成缺失的版本说明",
          "自动提交当前工作区源码，记录构建提交",
          "签名及公证预检、编译和打包",
          "核对依赖、签名、公证、更新清单与摘要",
          "自动创建并推送版本标签及当前分支",
          "上传附件并核对远端大小与 SHA256",
          values["draft-only"] ? "保留 GitHub 草稿" : "正式发布为最新稳定版本",
        ],
        note: "仅显示计划，基线与凭据尚未验证；此预览不会提交、上传或执行测试。",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

assert.equal(
  process.platform,
  platform === "mac" ? "darwin" : "win32",
  "正式签名打包必须在对应系统执行。",
);
assert.ok(
  !lstatSync("node_modules").isSymbolicLink(),
  "请用 npm ci 准备真实 node_modules 目录后运行自动升版命令。",
);
await mkdir(evidence, { recursive: true });
const controller = new AbortController();
let activeChild;
let commandEnv = process.env;
function interrupt(error = new Error("操作已中断，重新运行同一命令可续跑。")) {
  if (!controller.signal.aborted) controller.abort(error);
  if (!activeChild?.pid) return;
  if (process.platform === "win32")
    spawn("taskkill", ["/PID", String(activeChild.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  else {
    try {
      process.kill(-activeChild.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
const onInterrupt = () => interrupt();
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

async function run(
  file,
  args,
  { capture = false, optional = false, env = commandEnv } = {},
) {
  controller.signal.throwIfAborted();
  return await new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      cwd: root,
      env,
      detached: process.platform !== "win32",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
    }
    child.once("error", (error) => {
      activeChild = undefined;
      reject(error);
    });
    child.once("close", (code) => {
      activeChild = undefined;
      if (controller.signal.aborted) reject(controller.signal.reason);
      else if (code === 0 || optional)
        resolveRun({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      else
        reject(
          new Error(
            `${file} 执行失败（退出码 ${code ?? "中断"}），同一命令可重试。`,
          ),
        );
    });
  });
}

let releaseLock;
let state;
let statePersisted = false;
let lockCompromised = false;
async function saveState() {
  assert.ok(!lockCompromised, "升级任务已失去运行锁，停止写入记录。");
  await writeReleaseFileAtomic(
    statePath,
    JSON.stringify(state, null, 2) + "\n",
    { mode: 0o600 },
  );
  statePersisted = true;
}

async function prepareBaseline() {
  const candidates = values["from-dir"]
    ? [resolve(values["from-dir"])]
    : [
        ...(state.baselineDirectory ? [state.baselineDirectory] : []),
        join(root, "release", state.baseVersion),
        join(evidence, "baselines", state.baseVersion),
      ];
  if (!values["from-dir"]) {
    const common = await run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { capture: true, optional: true },
    );
    if (common.code === 0)
      candidates.push(
        join(dirname(common.stdout), "release", state.baseVersion),
      );
  }
  for (const directory of new Set(candidates)) {
    assert.notEqual(
      canonicalDirectory(directory),
      canonicalDirectory(state.output),
      "输出目录不能覆盖旧版基线。",
    );
    try {
      return await verifyMacBaseline(
        macBaselinePaths(state.baseVersion, directory),
      );
    } catch (error) {
      if (values["from-dir"]) throw error;
    }
  }
  const repository = updateConfig.getUpdateConfig().repository;
  assert.ok(repository, "没有本地旧包，且尚未配置官方发行仓库。");
  const cache = join(evidence, "baselines");
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(
    join(cache, `.download-${state.baseVersion}-`),
  );
  try {
    const zipName = `Panxu-Studio-${state.baseVersion}-mac-arm64.zip`;
    console.log(
      `准备官方差分基线 ${state.baseVersion}，从 ${repository} 下载缺失附件。`,
    );
    await run("gh", [
      "release",
      "download",
      `v${state.baseVersion}`,
      "--repo",
      repository,
      "--pattern",
      "latest-mac.yml",
      "--pattern",
      zipName,
      "--pattern",
      `${zipName}.blockmap`,
      "--dir",
      temporary,
    ]);
    await verifyMacBaseline(macBaselinePaths(state.baseVersion, temporary));
    // Keep an existing invalid cache for inspection instead of deleting it.
    const destination = existsSync(join(cache, state.baseVersion))
      ? `${temporary}-verified`
      : join(cache, state.baseVersion);
    assert.notEqual(
      canonicalDirectory(destination),
      canonicalDirectory(state.output),
      "输出目录不能覆盖旧版基线缓存。",
    );
    await rename(temporary, destination);
    return macBaselinePaths(state.baseVersion, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function prepareNotes() {
  const path = join(root, "docs", "releases", `${state.targetVersion}.md`);
  if (existsSync(path)) {
    assert.ok(
      readFileSync(path, "utf8").trim(),
      "当前版本说明为空，请填写后重试。",
    );
    return;
  }
  const tag = await run(
    "git",
    ["rev-parse", "--verify", `refs/tags/v${state.baseVersion}`],
    { capture: true, optional: true },
  );
  const commits =
    tag.code === 0
      ? await run(
          "git",
          ["log", `v${state.baseVersion}..HEAD`, "--format=%s", "-30"],
          { capture: true },
        )
      : null;
  const items = commits?.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => `- ${line.replace(/[\u0000-\u001f]/g, " ").slice(0, 240)}`)
    .join("\n");
  const text = `# 盘序 ${state.targetVersion}\n\n从 ${state.baseVersion} 准备${mode === "full" ? "全量发行" : "差分更新"}，版本号由发布命令自动递增。按当前工作区源码构建，以下提交标题不作为完整变更清单；未提交改动以本地源码为准。\n\n${items || "具体改动参见项目提交与本地改动。"}\n\n交付完整签名应用、更新文件与 blockmap。客户端具备旧 ZIP 缓存且网络支持时优先差分下载，条件不足时回退全量；安装需要重启。版本说明由脚本生成，未将生成说明视为测试或发布成功。\n`;
  await writeReleaseFileAtomic(path, text, { expectedText: null });
}

try {
  releaseLock = await lockfile.lock(join(root, "package.json"), {
    lockfilePath: join(root, ".panxu-release.lock"),
    retries: 0,
    stale: 60000,
    update: 10000,
    onCompromised: (error) => {
      lockCompromised = true;
      interrupt(error);
    },
  });
  state = await releasePlan();
  for (const name of ["latest-mac.yml", "latest.yml"]) {
    const path = join(state.output, name);
    if (existsSync(path))
      assert.equal(
        load(readFileSync(path, "utf8"))?.version,
        state.targetVersion,
        "输出目录已有其他版本，不能覆盖。",
      );
  }
  console.log(
    `${state.resumed ? "继续" : "开始"}${mode === "full" ? "全量" : "差分"}更新：${state.baseVersion} → ${state.targetVersion}`,
  );
  const reuseBuild = await canReuseReleaseBuild(run, state);
  const repository = updateConfig.getUpdateConfig().repository;
  assert.ok(repository, "缺少发行仓库配置。");
  const context = await releaseGitHubContext(run, repository);
  commandEnv = context.env;
  const remoteCommit = await remoteReleaseCommit(
    run,
    repository,
    `v${state.targetVersion}`,
    commandEnv,
  );
  if (remoteCommit) {
    assert.equal(
      remoteCommit,
      state.sourceCommit,
      "同名远端版本标签已存在且不属于本轮源码，禁止覆盖。",
    );
    assert.equal(
      state.buildCommit,
      state.sourceCommit,
      "已推送版本缺少对应构建记录，请保留产物与记录后排查。",
    );
  }
  state.format = 2;
  state.status = "pending";
  await saveState();
  if (!remoteCommit && !reuseBuild && mode === "differential") {
    const baseline = await prepareBaseline();
    state.baselineDirectory = baseline.directory;
  }
  controller.signal.throwIfAborted();
  if (!remoteCommit) {
    state.phase = "同步版本及说明";
    await saveState();
    await prepareNotes();
    controller.signal.throwIfAborted();
    await applyReleaseVersion(root, state.baseVersion, state.targetVersion);
    state.phase = "自动提交发行源码";
    await saveState();
    state.sourceCommit = await commitReleaseSource(run, state.targetVersion);
    if (reuseBuild) {
      state.buildCommit = state.sourceCommit;
      state.adoptedLegacyBuild = true;
      console.log(
        `复用 ${state.targetVersion} 已签名产物；应用源码和构建配置未变，继续校验与发布。`,
      );
    }
    await saveState();
  }
  const buildEnv = {
    ...commandEnv,
    PANXU_RELEASE_DIR: state.output,
    PANXU_REQUIRE_SIGNING: "1",
  };
  if (state.buildCommit !== state.sourceCommit) {
    state.phase = "签名打包与校验";
    await saveState();
    await run(
      process.execPath,
      [
        "scripts/package-release.mjs",
        "--mode",
        mode,
        "--platform",
        platform,
        "--arch",
        arch,
        ...(mode === "differential"
          ? ["--from", state.baseVersion, "--from-dir", state.baselineDirectory]
          : []),
      ],
      { env: buildEnv },
    );
    await assertCleanReleaseSource(run, state.sourceCommit);
    state.buildCommit = state.sourceCommit;
    state.buildCompletedAt = new Date().toISOString();
    await saveState();
  } else {
    await run(process.execPath, ["scripts/verify-release.mjs"], {
      env: buildEnv,
    });
  }
  await run(process.execPath, ["scripts/verify-updates.mjs", "--all"], {
    env: buildEnv,
  });
  state.phase = "自动推送源码及版本标签";
  await saveState();
  await pushReleaseSource(run, {
    repository,
    tag: `v${state.targetVersion}`,
    commit: state.sourceCommit,
    branch: context.branch,
    env: commandEnv,
  });
  state.pushedCommit = state.sourceCommit;
  state.phase = "上传并核验远端附件";
  await saveState();
  const notes = join(evidence, `publication-notes-${state.targetVersion}.md`);
  const committedNotes = await run(
    "git",
    ["show", `${state.sourceCommit}:docs/releases/${state.targetVersion}.md`],
    { capture: true },
  );
  await writeReleaseFileAtomic(notes, committedNotes.stdout + "\n");
  const publication = await publishRelease({
    run,
    repository,
    version: state.targetVersion,
    output: state.output,
    notes,
    env: commandEnv,
    publish: !values["draft-only"],
  });
  state.status = publication.published ? "complete" : "pending";
  state.phase = publication.published
    ? "正式发布完成"
    : "草稿已上传，等待正式发布";
  state.releaseUrl = publication.url;
  if (publication.published) {
    state.publishedAt = publication.publishedAt;
    state.completedAt = new Date().toISOString();
  }
  delete state.resumed;
  delete state.legacyBuild;
  delete state.lastError;
  await saveState();
  console.log(
    publication.published
      ? `版本 ${state.targetVersion} 已正式发布：${publication.url}。客户端现在可以检查更新。`
      : `版本 ${state.targetVersion} 的草稿已上传。点击 release:${mode} 即可继续正式发布，不再次升版。`,
  );
} catch (error) {
  if (state && statePersisted && releaseLock && !lockCompromised) {
    state.status = "pending";
    state.lastError = error.message;
    await saveState().catch(() => {});
  }
  console.error(
    error.code === "ELOCKED"
      ? "已有升级命令正在运行，请等待该任务完成。"
      : error.message,
  );
  process.exitCode = 1;
} finally {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
  if (!lockCompromised) await releaseLock?.();
}
