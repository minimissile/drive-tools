import assert from "node:assert/strict";

export async function releaseGitHubContext(run, repository) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
  };
  if (!env.HTTPS_PROXY && !env.https_proxy) {
    const proxy = await run("git", ["config", "--get", "http.proxy"], {
      capture: true,
      optional: true,
    });
    if (proxy.code === 0 && proxy.stdout) env.HTTPS_PROXY = proxy.stdout;
  }
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) {
    // Use an already stored owner credential without changing the active account.
    const token = await run(
      "gh",
      [
        "auth",
        "token",
        "--hostname",
        "github.com",
        "--user",
        repository.split("/")[0],
      ],
      { capture: true, optional: true, env },
    );
    if (token.code === 0 && token.stdout) env.GH_TOKEN = token.stdout;
  }
  const metadata = JSON.parse(
    (await run("gh", ["api", `repos/${repository}`], { capture: true, env }))
      .stdout,
  );
  assert.equal(metadata.private, false, "更新仓库必须公开。");
  assert.ok(
    metadata.permissions?.push,
    "当前 GitHub 凭据无发行仓库写入权限，请用仓库所有者或维护者账号登录 gh。",
  );
  const remote = (
    await run("git", ["remote", "get-url", "--push", "origin"], {
      capture: true,
    })
  ).stdout;
  const match = remote.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s]+?)(?:\.git)?\/?$/i,
  );
  assert.equal(
    match?.[1]?.toLowerCase(),
    repository.toLowerCase(),
    "origin 与配置的发行仓库不一致，已停止推送。",
  );
  const branch = (
    await run("git", ["symbolic-ref", "--short", "HEAD"], { capture: true })
  ).stdout;
  assert.ok(branch, "自动发布须在本地分支执行。");
  return { env, branch };
}

export async function remoteReleaseCommit(run, repository, tag, env) {
  const result = await run(
    "gh",
    ["api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"],
    { capture: true, optional: true, env },
  );
  if (result.code === 0) {
    assert.match(result.stdout, /^[a-f0-9]{40,64}$/, "远端标签提交无效。");
    return result.stdout;
  }
  if (/HTTP 404|\(404\)|HTTP 422|\(422\)/i.test(result.stderr)) return null;
  throw new Error(result.stderr || "无法检查远端版本标签。");
}

export async function assertCleanReleaseSource(run, commit) {
  const head = (await run("git", ["rev-parse", "HEAD"], { capture: true }))
    .stdout;
  assert.equal(
    head,
    commit,
    "构建期间源码提交已改变，同一命令可按当前源码重试。",
  );
  const changes = await run(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { capture: true },
  );
  assert.equal(
    changes.stdout,
    "",
    "构建期间源码发生改动，未发布。重新点击同一命令会对同一版本重新构建。",
  );
}

export async function commitReleaseSource(run, version) {
  const conflicts = await run(
    "git",
    ["diff", "--name-only", "--diff-filter=U"],
    { capture: true },
  );
  assert.equal(
    conflicts.stdout,
    "",
    "存在未解决的 Git 冲突，无法自动提交发行源码。",
  );
  await run("git", ["add", "--all", "--", "."]);
  const staged = await run("git", ["diff", "--cached", "--quiet"], {
    capture: true,
    optional: true,
  });
  if (staged.code === 1)
    await run("git", ["commit", "-m", `chore(release): publish ${version}`]);
  else assert.equal(staged.code, 0, "无法检查待提交源码。");
  const commit = (await run("git", ["rev-parse", "HEAD"], { capture: true }))
    .stdout;
  await assertCleanReleaseSource(run, commit);
  return commit;
}

export async function pushReleaseSource(
  run,
  { repository, tag, commit, branch, env },
) {
  const remote = await remoteReleaseCommit(run, repository, tag, env);
  if (remote) {
    assert.equal(remote, commit, `${tag} 已指向其他源码，禁止覆盖已有标签。`);
    return;
  }
  await assertCleanReleaseSource(run, commit);
  assert.equal(
    (await run("git", ["symbolic-ref", "--short", "HEAD"], { capture: true }))
      .stdout,
    branch,
    "发布过程中分支已切换，已停止推送。",
  );
  const local = await run(
    "git",
    ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`],
    { capture: true, optional: true },
  );
  if (local.code === 0)
    assert.equal(
      local.stdout,
      commit,
      `${tag} 的本地标签已指向其他源码，禁止覆盖。`,
    );
  else await run("git", ["tag", "-a", tag, "-m", `盘序 ${tag}`, commit]);
  await run(
    "git",
    [
      "-c",
      "http.version=HTTP/1.1",
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "--atomic",
      `https://github.com/${repository}.git`,
      `${commit}:refs/heads/${branch}`,
      `refs/tags/${tag}:refs/tags/${tag}`,
    ],
    { env },
  );
  assert.equal(
    await remoteReleaseCommit(run, repository, tag, env),
    commit,
    "推送后的远端标签与构建源码不一致。",
  );
}

// Migration for a completed build created by the former build-only commands.
// Reuse only when changes since that build are confined to release tooling and
// documentation. Application/build-input edits require a build of the same version.
export async function canReuseReleaseBuild(run, state) {
  const legacy = state.format === 1 && state.status === "complete";
  if (!legacy && !state.buildCommit) return false;
  const baseline = legacy ? "HEAD" : state.buildCommit;
  const headTime =
    Number(
      (await run("git", ["log", "-1", "--format=%ct"], { capture: true }))
        .stdout,
    ) * 1000;
  if (
    legacy &&
    (!Number.isFinite(headTime) || headTime > Date.parse(state.startedAt))
  )
    return false;
  const modified = (
    await run("git", ["diff", baseline, "--name-only", "-z"], { capture: true })
  ).stdout;
  const untracked = (
    await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      capture: true,
    })
  ).stdout;
  const allowed = (path) =>
    path === ".gitignore" ||
    path === "README.md" ||
    path === "package.json" ||
    path === "package-lock.json" ||
    path.startsWith("docs/") ||
    /^scripts\/(?:release-[a-z-]+|package-release|draft-release|verify-differential-update)\.mjs$/.test(
      path,
    );
  if (
    ![...modified.split("\0"), ...untracked.split("\0")]
      .filter(Boolean)
      .every(allowed)
  )
    return false;
  const { readFile } = await import("node:fs/promises");
  for (const path of ["package.json", "package-lock.json"]) {
    const previous = JSON.parse(
      (await run("git", ["show", `${baseline}:${path}`], { capture: true }))
        .stdout,
    );
    const current = JSON.parse(await readFile(path, "utf8"));
    if (!legacy && previous.version !== current.version) return false;
    for (const value of [previous, current]) {
      delete value.version;
      if (path === "package.json") delete value.scripts;
      else if (value.packages?.[""]) delete value.packages[""].version;
    }
    if (JSON.stringify(previous) !== JSON.stringify(current)) return false;
  }
  return true;
}
