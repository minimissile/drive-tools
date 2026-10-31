import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext, Page } from "playwright-core";
import type { Repository } from "./repository";
import type { BitBrowser } from "./bitbrowser";
import type { BrowserEnvironments } from "./browser-environments";
import type {
  DriveBrowserBinding,
  DriveBrowserPreview,
  NewDriveBrowserPreview,
} from "../shared/drive-browser";
import { id, now } from "./database";
import { AppError } from "./errors";
import { browserExitIp } from "./browser-exit-ip";
import { isBaiduSharedMember } from "../shared/browser-environment-sharing";
import {
  providerApiAllowed,
  providerAuthAllowed,
  providerSpecs,
} from "../shared/providers";
import { browserPageRequest } from "./browser-page-request";
import { findEnvironmentPage, officialBrowserPage } from "./browser-pages";

interface Dependencies {
  repo: Repository;
  bit: BitBrowser;
  environments: BrowserEnvironments;
  locked<T>(id: string, action: () => Promise<T>): Promise<T>;
  assertIdle(id: string): void;
  changed(): void;
}
interface PreviewRecord {
  view: DriveBrowserPreview;
  connectorKey: string;
  signature: string;
  expires: number;
}
interface NewPreviewRecord {
  view: NewDriveBrowserPreview;
  connectorKey: string;
  signature: string;
  expires: number;
}
const key = (id: string) => `drive-browser:${id}`;
const identityUrl =
  "https://pan.baidu.com/api/gettemplatevariable?fields=%5B%22uk%22%2C%22bdstoken%22%2C%22username%22%5D&clienttype=0&web=1";

/** All bound Baidu traffic stays in the selected profile; failure never selects native transport. */
export class DriveBrowserSessions {
  private previews = new Map<string, PreviewRecord>();
  private newPreviews = new Map<string, NewPreviewRecord>();
  private active = 0;
  constructor(private d: Dependencies) {
    for (const a of d.repo.accounts()) {
      const setting = `drive-browser-mode:${a.id}`;
      if (!this.db.setting(setting, null))
        this.db.setSetting(
          setting,
          this.isBound(a.id) ? "bitbrowser" : "electron",
        );
    }
  }
  get isBusy() {
    return this.active > 0;
  }
  private async withAccount<T>(accountId: string, action: () => Promise<T>) {
    this.active++;
    try {
      return await this.d.locked(accountId, action);
    } finally {
      this.active--;
    }
  }
  private get db() {
    return this.d.repo.db;
  }
  isBound(accountId: string) {
    const link = this.db.get<{ engine: string }>(
      "SELECT e.engine FROM browser_environment_accounts a JOIN browser_environments e ON e.id=a.environment_id WHERE a.kind='drive' AND a.account_id=?",
      accountId,
    );
    // A damaged/missing association with a retained binding is also blocked from native fallback.
    return (
      this.db.setting<"electron" | "bitbrowser">(
        `drive-browser-mode:${accountId}`,
        "electron",
      ) === "bitbrowser" ||
      link?.engine === "bitbrowser" ||
      !!this.db.setting(key(accountId), null)
    );
  }
  private binding(accountId: string) {
    const b = this.db.setting<DriveBrowserBinding | null>(key(accountId), null);
    if (!b || !b.profileId || !b.uid || !b.environmentId)
      throw new AppError(
        "DRIVE_BINDING_UNVERIFIED",
        "此百度账号的比特关联尚未核验，请在账号管理重新读取并关联环境。",
      );
    const env = this.d.environments.forAccount({
      kind: "drive",
      id: accountId,
    });
    if (
      env.id !== b.environmentId ||
      env.engine !== "bitbrowser" ||
      env.profileId !== b.profileId ||
      b.connectorKey !== this.db.setting("bitUrl", "")
    )
      throw new AppError(
        "DRIVE_ENVIRONMENT_CHANGED",
        "百度账号的浏览器关联或比特连接已变化，请重新核验关联；不会改用内置会话。",
      );
    return b;
  }
  private assertBaidu(accountId: string) {
    const a = this.d.repo.getAccount(accountId);
    if (a.provider !== "baidu")
      throw new AppError(
        "BAIDU_REQUIRED",
        "本轮仅支持百度网盘关联比特无头环境。",
      );
    if (!a.enabled) throw new AppError("ACCOUNT_DISABLED", "请先启用此账号。");
    return a;
  }
  private assertNoPending(accountId: string) {
    this.d.assertIdle(accountId);
    if (
      this.db.get(
        "SELECT key FROM settings WHERE substr(key,1,length(?))=? AND value!='null' LIMIT 1",
        `drive-write-pending:${accountId}:`,
        `drive-write-pending:${accountId}:`,
      ) ||
      this.db.get(
        "SELECT file_id FROM drive_share_intents WHERE account_id=? AND json_extract(data,'$.state') IN ('requested','created','uncertain') LIMIT 1",
        accountId,
      ) ||
      this.db.get(
        "SELECT key FROM settings WHERE key LIKE 'share-creation:%' AND json_valid(value) AND json_extract(value,'$.accountId')=? AND json_extract(value,'$.receipt.state')='uncertain' LIMIT 1",
        accountId,
      ) ||
      this.db.get(
        "SELECT r.id FROM insertion_runs r,json_each(r.data,'$.items') i WHERE json_extract(i.value,'$.target.accountId')=? AND json_extract(i.value,'$.state') IN ('writing','uncertain') LIMIT 1",
        accountId,
      )
    )
      throw new AppError(
        "DRIVE_PENDING_RESULT",
        "此账号存在尚未核对的网盘操作，请先处理结果，再改变浏览器关联。",
      );
  }
  private async page(context: BrowserContext, accountId: string) {
    const page = await findEnvironmentPage(
      context,
      `panxu:baidu-drive:${accountId}`,
      providerSpecs.baidu.home,
    );
    if (!officialBrowserPage(page, ["pan.baidu.com"]))
      throw new AppError(
        "AUTH_EXPIRED",
        "百度网页要求重新登录，请打开关联环境的登录窗口处理。",
      );
    return page;
  }
  private async identity(page: Page) {
    const response = await browserPageRequest(page, identityUrl);
    let data: any;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw new AppError(
        "AUTH_EXPIRED",
        "百度未返回有效登录身份，请打开关联环境完成登录。",
      );
    }
    const value = data.result ?? data.data;
    if (
      response.status !== 200 ||
      Number(data.errno ?? 0) !== 0 ||
      !value?.uk ||
      !value?.bdstoken
    )
      throw new AppError(
        "AUTH_EXPIRED",
        "此比特环境中的百度登录已失效，请完成官方登录后关闭窗口，再核验后台登录。",
      );
    return { uid: String(value.uk), nickname: String(value.username ?? "") };
  }
  private pin(accountId: string | undefined, uid: string) {
    const a = accountId ? this.d.repo.getAccount(accountId) : undefined;
    if (a?.uid && a.uid !== uid)
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        "此比特环境中的百度 UID 与原账号不同，请选择原账号环境或新建账号记录。",
      );
    if (
      this.d.repo
        .accounts()
        .some(
          (other) =>
            other.id !== accountId &&
            other.provider === "baidu" &&
            other.uid === uid,
        )
    )
      throw new AppError(
        "DUPLICATE_ACCOUNT",
        "此百度 UID 已有账号记录，请使用原记录关联环境。",
      );
  }
  private async inspect(input: {
    accountId?: string;
    profileId: string;
    connectorKey: string;
    requireProxy: boolean;
  }) {
    if (input.accountId) this.assertBaidu(input.accountId);
    if (input.connectorKey !== this.db.setting("bitUrl", ""))
      throw new AppError(
        "BIT_CONNECTION_CHANGED",
        "比特连接已变化，请重新读取环境列表。",
      );
    const profile = (await this.d.bit.profiles()).find(
      (p) => p.id === input.profileId,
    );
    if (!profile)
      throw new AppError(
        "BIT_PROFILE_INVALID",
        "所选比特环境不存在或不可访问。",
      );
    const existing = this.db.get<{ id: string }>(
      "SELECT id FROM browser_environments WHERE engine='bitbrowser' AND profile_id=?",
      input.profileId,
    );
    if (existing) {
      const env = this.d.environments.get(existing.id);
      if (env.connectorKey && env.connectorKey !== input.connectorKey)
        throw new AppError(
          "ENVIRONMENT_CONNECTOR_CHANGED",
          "所选环境登记于另一个比特连接，请恢复原连接或选择其他环境。",
        );
      if (
        this.d.environments
          .list()
          .find((e) => e.id === existing.id)
          ?.accounts.some((r) =>
            r.kind === "drive"
              ? r.id !== input.accountId
              : !isBaiduSharedMember(r),
          )
      )
        throw new AppError(
          "DRIVE_PROFILE_EXCLUSIVE",
          "此环境已有百度网盘或不支持共用的平台账号，请选择空闲环境或仅关联贴吧、知道的环境。",
        );
    }
    const requireProxy =
      input.requireProxy ||
      !!(existing && this.d.environments.get(existing.id).requireProxy);
    const config = await this.d.bit.environmentConfiguration(input.profileId);
    const details = await this.d.bit.profileDetails(input.profileId);
    if (details.randomFingerprint)
      throw new AppError(
        "BIT_RANDOM_FINGERPRINT",
        "请先在比特客户端关闭每次启动随机指纹，保持此账号环境稳定。",
      );
    if (requireProxy && config.proxy !== "configured")
      throw new AppError(
        "ENVIRONMENT_PROXY_REQUIRED",
        "此比特环境未配置代理。请在比特客户端配置代理，并开启网络不通停止打开，再读取登录账号。",
      );
    if (requireProxy && !config.stopWhileNetError)
      throw new AppError(
        "ENVIRONMENT_PROXY_REQUIRED",
        "此环境已配置代理，但未开启网络不通停止打开。请在比特客户端编辑该环境，开启此项并保存后重试。",
      );
    const action = () =>
      this.d.bit.withDriveProfile(
        input.profileId,
        true,
        async (context, mode) => {
          const identity = await this.identity(
            await this.page(
              context,
              input.accountId ?? `new:${input.profileId}`,
            ),
          );
          this.pin(input.accountId, identity.uid);
          return {
            ...identity,
            exitIp: await browserExitIp(context),
            headless: mode.headless,
          };
        },
        input.connectorKey,
      );
    const state = await (existing
      ? this.d.environments.controlWindow(existing.id, action)
      : action());
    if (input.connectorKey !== this.db.setting("bitUrl", ""))
      throw new AppError(
        "BIT_CONNECTION_CHANGED",
        "读取期间比特连接变化，请重新读取。",
      );
    const after = await this.d.bit.environmentConfiguration(input.profileId);
    if (after.signature !== config.signature)
      throw new AppError(
        "ENVIRONMENT_CHANGED",
        "读取期间代理或指纹配置已变化，请重新读取。",
      );
    return {
      state,
      signature: config.signature,
      profileName: profile.name,
      requireProxy,
    };
  }
  private assertPinned(
    accountId: string,
    profileId: string,
    connectorKey: string,
  ) {
    const a = this.assertBaidu(accountId);
    const b = this.db.setting<DriveBrowserBinding | null>(key(accountId), null);
    if (
      a.browserEngine !== "bitbrowser" ||
      !b ||
      b.profileId !== profileId ||
      b.connectorKey !== connectorKey
    )
      throw new AppError(
        "ACCOUNT_BROWSER_FIXED",
        "账号的浏览器方式和指纹环境在创建时固定，不能改绑。请使用原环境重新登录或新建账号。",
      );
  }
  previewNew(input: {
    profileId: string;
    connectorKey: string;
    requireProxy: boolean;
  }) {
    return this.withAccount(`drive-create:${input.profileId}`, async () => {
      const result = await this.inspect(input);
      for (const [token, p] of this.newPreviews)
        if (p.expires < Date.now()) this.newPreviews.delete(token);
      const view: NewDriveBrowserPreview = {
        token: randomUUID(),
        profileId: input.profileId,
        profileName: result.profileName,
        requireProxy: result.requireProxy,
        ...result.state,
      };
      this.newPreviews.set(view.token, {
        view,
        connectorKey: input.connectorKey,
        signature: result.signature,
        expires: Date.now() + 10 * 60000,
      });
      return view;
    });
  }
  async createAccount(alias: string, token: string) {
    const preview = this.newPreviews.get(token);
    if (!preview)
      throw new AppError("DRIVE_PREVIEW_EXPIRED", "请先读取要创建的百度账号。");
    return this.withAccount(
      `drive-create:${preview.view.profileId}`,
      async () => {
        if (
          this.newPreviews.get(token) !== preview ||
          preview.expires < Date.now()
        )
          throw new AppError(
            "DRIVE_PREVIEW_EXPIRED",
            "读取结果已使用或过期，请重新读取。",
          );
        const v = preview.view;
        const result = await this.inspect({
          ...v,
          connectorKey: preview.connectorKey,
        });
        if (
          result.state.uid !== v.uid ||
          result.state.exitIp !== v.exitIp ||
          result.signature !== preview.signature
        )
          throw new AppError(
            "DRIVE_PREVIEW_CHANGED",
            "百度账号、出口或指纹配置已变化，请重新读取。",
          );
        let env = this.db.get<{ id: string }>(
          "SELECT id FROM browser_environments WHERE engine='bitbrowser' AND profile_id=?",
          v.profileId,
        );
        if (!env)
          env = await this.d.environments.save({
            name: v.profileName.slice(0, 80),
            engine: "bitbrowser",
            profileId: v.profileId,
            expectedConnectorKey: preview.connectorKey,
            requireProxy: v.requireProxy,
          });
        const accountId = id("account"),
          time = now();
        this.pin(undefined, v.uid);
        const binding: DriveBrowserBinding = {
          environmentId: env.id,
          profileId: v.profileId,
          profileName: v.profileName,
          connectorKey: preview.connectorKey,
          signature: preview.signature,
          uid: v.uid,
          nickname: v.nickname,
          exitIp: v.exitIp,
          requireProxy: v.requireProxy,
          boundAt: time,
        };
        this.db.transaction(() => {
          const isDefault = !this.d.repo
            .accounts()
            .some((a) => a.provider === "baidu" && a.enabled);
          this.db.run(
            "INSERT INTO accounts(id,provider,alias,uid,is_default,status,verified_at,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            accountId,
            "baidu",
            alias,
            v.uid,
            Number(isDefault),
            result.state.headless ? "connected" : "expired",
            result.state.headless ? time : null,
            result.state.headless ? null : "请将已选环境转为后台后核验登录",
            time,
            time,
          );
          this.d.environments.registerAccount(
            { kind: "drive", id: accountId },
            env!.id,
            { requireProxy: v.requireProxy },
          );
          this.db.setSetting(key(accountId), binding);
          this.db.setSetting(`drive-browser-mode:${accountId}`, "bitbrowser");
          if (result.state.headless)
            this.d.environments.confirm(
              { kind: "drive", id: accountId },
              v.uid,
            );
        });
        this.newPreviews.delete(token);
        this.d.changed();
        return this.d.repo.getAccount(accountId);
      },
    );
  }
  preview(input: {
    accountId: string;
    profileId: string;
    connectorKey: string;
    requireProxy: boolean;
  }) {
    return this.withAccount(input.accountId, async () => {
      this.assertPinned(input.accountId, input.profileId, input.connectorKey);
      this.assertNoPending(input.accountId);
      const result = await this.inspect(input);
      for (const [id, p] of this.previews)
        if (p.expires < Date.now()) this.previews.delete(id);
      const view: DriveBrowserPreview = {
        token: randomUUID(),
        accountId: input.accountId,
        profileId: input.profileId,
        profileName: result.profileName,
        requireProxy: result.requireProxy,
        ...result.state,
      };
      this.previews.set(view.token, {
        view,
        connectorKey: input.connectorKey,
        signature: result.signature,
        expires: Date.now() + 10 * 60000,
      });
      return view;
    });
  }
  async bind(token: string) {
    const preview = this.previews.get(token);
    if (!preview || preview.expires < Date.now())
      throw new AppError(
        "DRIVE_PREVIEW_EXPIRED",
        "账号读取结果已过期，请重新读取。",
      );
    return this.withAccount(preview.view.accountId, async () => {
      if (this.previews.get(token) !== preview || preview.expires < Date.now())
        throw new AppError(
          "DRIVE_PREVIEW_EXPIRED",
          "此读取结果已使用或过期，请重新读取账号。",
        );
      const v = preview.view;
      this.assertPinned(v.accountId, v.profileId, preview.connectorKey);
      this.assertNoPending(v.accountId);
      const result = await this.inspect({
        ...v,
        connectorKey: preview.connectorKey,
      });
      if (
        result.state.uid !== v.uid ||
        result.state.exitIp !== v.exitIp ||
        result.signature !== preview.signature
      )
        throw new AppError(
          "DRIVE_PREVIEW_CHANGED",
          "账号、出口或指纹配置已变化，请重新读取后关联。",
        );
      let env = this.db.get<{ id: string }>(
        "SELECT id FROM browser_environments WHERE engine='bitbrowser' AND profile_id=?",
        v.profileId,
      );
      if (!env)
        env = await this.d.environments.save({
          name: v.profileName.slice(0, 80),
          engine: "bitbrowser",
          profileId: v.profileId,
          expectedConnectorKey: preview.connectorKey,
          requireProxy: v.requireProxy,
        });
      if (
        !this.db.get(
          "SELECT account_id FROM browser_environment_accounts WHERE kind='drive' AND account_id=?",
          v.accountId,
        )
      )
        this.d.environments.registerAccount({ kind: "drive", id: v.accountId });
      this.assertBaidu(v.accountId);
      await this.d.environments.bind(
        { kind: "drive", id: v.accountId },
        env.id,
        { requireProxy: v.requireProxy },
      );
      this.assertNoPending(v.accountId);
      const binding: DriveBrowserBinding = {
        environmentId: env.id,
        profileId: v.profileId,
        profileName: v.profileName,
        connectorKey: preview.connectorKey,
        signature: preview.signature,
        uid: v.uid,
        nickname: v.nickname,
        exitIp: v.exitIp,
        requireProxy: v.requireProxy,
        boundAt: now(),
      };
      this.db.transaction(() => {
        this.db.setSetting(key(v.accountId), binding);
        this.db.run(
          "UPDATE accounts SET uid=?,status=?,verified_at=?,error=?,updated_at=? WHERE id=?",
          v.uid,
          result.state.headless ? "connected" : "expired",
          result.state.headless ? now() : null,
          result.state.headless
            ? null
            : "已关联比特环境，请关闭可见窗口后核验后台登录。",
          now(),
          v.accountId,
        );
        this.invalidate(v.accountId);
      });
      if (result.state.headless)
        this.d.environments.confirm({ kind: "drive", id: v.accountId }, v.uid);
      this.previews.delete(token);
      this.d.changed();
      return { ...v, headless: result.state.headless };
    });
  }
  private invalidate(accountId: string) {
    this.db.run(
      "UPDATE copies SET share_verified_at=NULL,share_version=share_version+1 WHERE account_id=?",
      accountId,
    );
    this.db.run(
      "UPDATE drafts SET reviewed=0 WHERE copy_id IN (SELECT id FROM copies WHERE account_id=?)",
      accountId,
    );
  }
  async unbind(accountId: string) {
    throw new AppError(
      "ACCOUNT_BROWSER_FIXED",
      "账号的浏览器方式在创建时固定，不能解除或改绑。可停用此账号，或新建另一种方式的账号。",
    );
  }
  /** Clear local verification while preserving the account's immutable browser selection. */
  async clearSession(accountId: string) {
    this.d.environments.assertAccountIdle({ kind: "drive", id: accountId });
    await this.stopBackground(accountId);
    this.d.environments.assertAccountIdle({ kind: "drive", id: accountId });
    this.d.environments.invalidateIdentity({ kind: "drive", id: accountId });
  }
  private async stopBackground(accountId: string) {
    const b = this.db.setting<DriveBrowserBinding | null>(key(accountId), null);
    if (!b || b.connectorKey !== this.db.setting("bitUrl", "")) return false;
    // Local detachment still works if BitBrowser is offline. Never close a different connector's profile.
    try {
      await this.d.environments.controlWindow(b.environmentId, () =>
        this.d.bit.stopDriveHeadless(b.profileId, b.connectorKey),
      );
      return true;
    } catch {
      return false;
    }
  }
  private async run<T>(
    accountId: string,
    action: (
      context: BrowserContext,
      page: Page,
      b: DriveBrowserBinding,
    ) => Promise<T>,
  ) {
    const a = this.assertBaidu(accountId),
      b = this.binding(accountId);
    return this.d.environments.runEnvironment(
      b.environmentId,
      `drive:${accountId}`,
      async () => {
        const env = this.d.environments.get(b.environmentId);
        if (
          env.externalSignature !== b.signature ||
          ((env.requireProxy || b.requireProxy) && env.network?.ip !== b.exitIp)
        )
          throw new AppError(
            "DRIVE_ENVIRONMENT_CHANGED",
            "此账号的指纹配置或出口 IP 已变化，请在账号管理重新读取并关联环境。",
          );
        if (
          !env.requireProxy &&
          !b.requireProxy &&
          (await this.d.bit.environmentExitIp(b.profileId, true)) !== b.exitIp
        )
          throw new AppError(
            "DRIVE_ENVIRONMENT_CHANGED",
            "此账号的出口 IP 已变化，请重新读取并关联环境。",
          );
        return this.d.bit.withDriveProfile(
          b.profileId,
          false,
          async (context) => {
            const page = await this.page(context, accountId),
              identity = await this.identity(page);
            if (identity.uid !== b.uid || (a.uid && identity.uid !== a.uid))
              throw new AppError(
                "ACCOUNT_UID_MISMATCH",
                "比特环境已切换百度账号，已阻止此账号继续操作。",
              );
            this.d.environments.confirm(
              { kind: "drive", id: accountId },
              identity.uid,
            );
            return action(context, page, b);
          },
          b.connectorKey,
        );
      },
      { headless: true, requireProxy: b.requireProxy },
    );
  }
  request(accountId: string, url: string, init: RequestInit = {}) {
    if (!providerApiAllowed("baidu", url))
      throw new AppError(
        "PROVIDER_URL_BLOCKED",
        "请求不属于百度网盘允许接口。",
      );
    return this.run(accountId, async (_context, page) => {
      const headers = new Headers(init.headers);
      for (const name of [...headers.keys()])
        if (
          [
            "cookie",
            "origin",
            "referer",
            "host",
            "user-agent",
            "content-length",
          ].includes(name) ||
          name.startsWith("sec-")
        )
          headers.delete(name);
      return browserPageRequest(page, url, { ...init, headers });
    });
  }
  setCookie(accountId: string, url: string, name: string, value: string) {
    if (new URL(url).origin !== "https://pan.baidu.com" || name !== "BDCLND")
      throw new AppError("COOKIE_SCOPE", "不支持向此环境写入该会话字段。");
    return this.run(accountId, async (context) => {
      await context.addCookies([
        { url, name, value, secure: true, httpOnly: true, sameSite: "Lax" },
      ]);
    });
  }
  /** Explicit user action: close this profile's windows, preserve cookies, then start in background. */
  background(accountId: string) {
    return this.withAccount(accountId, async () => {
      this.assertBaidu(accountId);
      this.assertNoPending(accountId);
      const b = this.binding(accountId);
      await this.d.environments.controlWindow(b.environmentId, async () => {
        await this.d.bit.closeProfile(b.profileId, b.connectorKey);
        const deadline = Date.now() + 6000;
        while (
          (await this.d.bit.runningProfiles([b.profileId])).has(b.profileId)
        ) {
          if (Date.now() >= deadline)
            throw new AppError(
              "BIT_WINDOW_CLOSING",
              "此环境尚未完全关闭，请稍后再转为后台。",
            );
          await delay(250);
        }
        await this.d.bit.withDriveProfile(
          b.profileId,
          false,
          async () => {},
          b.connectorKey,
        );
      });
      this.db.run(
        "UPDATE accounts SET verified_at=NULL,error='已转为后台，请核验后台登录',updated_at=? WHERE id=?",
        now(),
        accountId,
      );
      const capacity = this.d.repo.getAccount(accountId).capacity;
      if (capacity)
        this.db.setSetting(`account:capacity:${accountId}`, {
          ...capacity,
          error: null,
        });
      this.d.changed();
      return { headless: true as const };
    });
  }
  async open(accountId: string, url = providerSpecs.baidu.home) {
    if (!providerAuthAllowed("baidu", url))
      throw new AppError("ACCOUNT_PAGE_BLOCKED", "此地址不属于百度官方页面。");
    const b = this.binding(accountId);
    return this.d.environments.controlWindow(b.environmentId, async () => {
      await this.d.bit.stopDriveHeadless(b.profileId, b.connectorKey);
      await this.d.bit.withProfile(
        b.profileId,
        async (context) => {
          const page = await context.newPage();
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await page.bringToFront();
        },
        b.connectorKey,
      );
    });
  }
}
