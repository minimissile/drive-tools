import { z } from "zod";
import { id, now } from "../database";
import { AppError } from "../errors";
import { normalizedDirectory } from "../providers/provider";
import { providerSchema } from "../../shared/schemas";

import type { HandlerServices, HandlerMap } from "./types";

export function createAccountHandlers(
  services: Pick<
    HandlerServices,
    | "account"
    | "assertNoActiveJobs"
    | "changed"
    | "db"
    | "ports"
    | "queue"
    | "refreshCapacity"
    | "repo"
    | "environments"
    | "lockedAccount"
    | "driveBrowsers"
  >,
) {
  return {
    "account.add": async (object) => {
      const input = z
          .object({
            provider: providerSchema,
            alias: z.string().trim().min(1).max(60),
            browser: z
              .discriminatedUnion("engine", [
                z.object({ engine: z.literal("electron") }),
                z.object({
                  engine: z.literal("bitbrowser"),
                  previewToken: z.string().uuid(),
                }),
              ])
              .default({ engine: "electron" }),
          })
          .parse(object),
        accountId = id("account"),
        time = now();
      if (input.browser.engine === "bitbrowser") {
        if (input.provider !== "baidu")
          throw new AppError(
            "BAIDU_REQUIRED",
            "指纹浏览器当前仅支持百度网盘。",
          );
        return services.driveBrowsers.createAccount(
          input.alias,
          input.browser.previewToken,
        );
      }
      const isDefault = !services.repo
        .accounts()
        .some((a) => a.provider === input.provider && a.enabled);
      services.db.transaction(() => {
        services.db.run(
          "INSERT INTO accounts(id,provider,alias,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          accountId,
          input.provider,
          input.alias,
          Number(isDefault),
          time,
          time,
        );
        if (input.provider === "baidu")
          services.environments.registerAccount({
            kind: "drive",
            id: accountId,
          });
        services.db.setSetting(`drive-browser-mode:${accountId}`, "electron");
      });
      services.changed();
      return services.repo.getAccount(accountId);
    },
    "account.update": async (object) => {
      const input = z
        .object({
          id: z.string(),
          alias: z.string().trim().min(1).max(60),
          defaultDirectory: z.string().max(500),
          enabled: z.boolean(),
        })
        .parse(object);
      return services.lockedAccount(input.id, async () => {
        const account = services.repo.getAccount(input.id);
        if (!input.enabled) services.assertNoActiveJobs(account.id);
        services.db.run(
          "UPDATE accounts SET alias=?,default_directory=?,enabled=?,status=CASE WHEN ?=0 THEN ? WHEN uid IS NOT NULL THEN ? ELSE ? END,updated_at=? WHERE id=?",
          input.alias,
          normalizedDirectory(input.defaultDirectory),
          Number(input.enabled),
          Number(input.enabled),
          "disabled",
          account.status === "disabled" ? "expired" : account.status,
          "disconnected",
          now(),
          input.id,
        );
        if (!input.enabled)
          services.db.run(
            "UPDATE accounts SET is_default=0 WHERE id=?",
            input.id,
          );
        services.changed();
        return services.repo.getAccount(input.id);
      });
    },
    "account.default": async (object) => {
      const { id: accountId } = z.object({ id: z.string() }).parse(object),
        account = services.account(accountId);
      services.db.transaction(() => {
        services.db.run(
          "UPDATE accounts SET is_default=0 WHERE provider=?",
          account.provider,
        );
        services.db.run(
          "UPDATE accounts SET is_default=1 WHERE id=?",
          account.id,
        );
      });
      services.changed();
      return true;
    },
    "account.login": async (object) => {
      const { id: accountId } = z.object({ id: z.string() }).parse(object);
      return services.lockedAccount(accountId, async () => {
        services.assertNoActiveJobs(accountId);
        await services.ports.login(services.account(accountId));
        return true;
      });
    },
    "account.check": async (object) => {
      const { id: accountId } = z.object({ id: z.string() }).parse(object);
      const account = await services.refreshCapacity(accountId);
      if (account.status !== "connected")
        throw new AppError(
          "AUTH_EXPIRED",
          account.error ?? "登录已失效，请重新登录。",
        );
      await services.ports.closeAccountWindow(accountId);
      services.db.run(
        "UPDATE jobs SET stage=?,error=NULL WHERE copy_id IN (SELECT id FROM copies WHERE account_id=?) AND stage=?",
        "queued",
        account.id,
        "waiting_login",
      );
      void services.queue.pump();
      return account;
    },
    "account.capacity": async (object) => {
      const { id: accountId } = z.object({ id: z.string() }).parse(object);
      return services.refreshCapacity(accountId);
    },
    "account.clear": async (object) => {
      const { id: accountId } = z.object({ id: z.string() }).parse(object);
      return services.lockedAccount(accountId, async () => {
        services.assertNoActiveJobs(accountId);
        await services.ports.clearSession(accountId);
        services.db.run(
          "UPDATE accounts SET status=?,enabled=0,is_default=0,verified_at=NULL WHERE id=?",
          "disabled",
          accountId,
        );
        services.changed();
        return true;
      });
    },
  } satisfies HandlerMap;
}
