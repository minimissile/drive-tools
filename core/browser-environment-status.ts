import type { Database } from "./database";
import type { BrowserEnvironments } from "./browser-environments";
import type { EnvironmentAccountRef } from "../shared/browser-environments";
import type { BitBrowserAccountState } from "../shared/bitbrowser";
import type { WeiboPost } from "../shared/weibo-posts";
import type { WeiboMarketingRun } from "../shared/weibo-marketing";
import type { CsdnWorkflow } from "../shared/csdn-workflow";

/** Local observations only: inspecting a window never logs in or calls a platform. */
export function createEnvironmentStatus(deps: {
  db: Database;
  environments: BrowserEnvironments;
  posts(): WeiboPost[];
  marketing(): WeiboMarketingRun[];
  csdn(): CsdnWorkflow[];
}) {
  return {
    account(ref: EnvironmentAccountRef): BitBrowserAccountState {
      const link = deps.environments.link(ref);
      let status = "disconnected";
      if (ref.kind === "website")
        status =
          deps.db.get<{ status: string }>(
            "SELECT status FROM website_accounts WHERE id=?",
            ref.id,
          )?.status ?? status;
      else if (ref.kind === "zhidao") {
        const row = deps.db.get<{ data: string }>(
          "SELECT data FROM zhidao_accounts WHERE id=?",
          ref.id,
        );
        if (row) status = JSON.parse(row.data).status;
      }
      const verified =
        status === "connected" && deps.environments.identityCurrent(ref);
      return {
        ...ref,
        alias: link.alias,
        platform: link.platform,
        uid: link.uid,
        status:
          status === "expired"
            ? "expired"
            : verified
              ? "verified"
              : "unverified",
        message:
          ref.kind === "binding"
            ? "发布能力与网页登录身份分开核验，请在平台窗口确认当前账号。"
            : verified
              ? "上次核验有效；执行平台操作时仍会按业务要求检查。"
              : status === "expired"
                ? "登录已失效，请在账号管理重新登录并检查。"
                : "尚未核验或环境已变化，请在账号管理检查登录。",
      };
    },
    pending(refs: EnvironmentAccountRef[]) {
      if (!refs.some((ref) => ref.kind === "website" || ref.kind === "binding"))
        return [];
      const websites = new Set(
        refs.filter((ref) => ref.kind === "website").map((ref) => ref.id),
      );
      const bindings = new Set(
        refs.filter((ref) => ref.kind === "binding").map((ref) => ref.id),
      );
      const notes: string[] = [];
      for (const post of deps.posts())
        if (
          websites.has(post.accountId) &&
          ["filled", "filling", "submitting", "uncertain"].includes(post.stage)
        )
          notes.push(
            `微博草稿 ${post.id}：${post.stage === "uncertain" ? "提交结果待核对" : "已有页面填写或提交操作"}`,
          );
      for (const run of deps.marketing())
        if (
          run.options &&
          websites.has(run.options.accountId) &&
          ["filled", "submitting", "handoff", "uncertain"].includes(run.stage)
        )
          notes.push(
            `微博图文 ${run.id}：${run.stage === "uncertain" ? "提交结果待核对" : "已填写或已交接到平台"}`,
          );
      for (const run of deps.csdn())
        if (
          run.options &&
          bindings.has(run.options.bindingId) &&
          ["ready", "submitting", "uncertain"].includes(run.stage)
        )
          notes.push(
            `CSDN 内容 ${run.id}：${run.stage === "uncertain" ? "提交结果待核对" : "已有页面填写或提交操作"}`,
          );
      return notes;
    },
  };
}
