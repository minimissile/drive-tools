import { providerSpecs } from "../../shared/providers";
import type { SecretStore } from "../secrets";
import type { ProviderTransport } from "./provider";
import { AppError } from "../errors";

const fields = [
  "authorization",
  "x-device-id",
  "x-client-id",
  "x-captcha-token",
  "user-agent",
  "did",
  "dt",
  "smid",
] as const;
const cmccFields = [
  "authorization",
  "user-agent",
  "mcloud-skey",
  "mcloud-client",
  "mcloud-version",
  "x-yun-client-info",
  "x-deviceinfo",
];
interface SessionRecord {
  headers: Record<string, string>;
  refreshToken?: string;
}

/** Credentials originate only from that account's official isolated window. */
export class WebTokenSession {
  private pending = new Map<string, Promise<void>>();
  private refreshing = new Map<string, Promise<Record<string, string>>>();
  constructor(
    private secrets: () => SecretStore,
    private transport: ProviderTransport,
    readonly provider: "xunlei" | "pikpak" | "guangya" | "cmcc" = "xunlei",
  ) {}
  private valid(headers: Record<string, string>) {
    if (this.provider === "cmcc") {
      const value = headers.authorization ?? "";
      if (!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
      return /^pc:[+\d]{5,20}:[^\r\n]+$/.test(
        Buffer.from(value.slice(6), "base64").toString("utf8"),
      );
    }
    return (
      /^Bearer \S+$/i.test(headers.authorization ?? "") &&
      (this.provider === "guangya" ||
        (!!headers["x-device-id"] && !!headers["x-client-id"]))
    );
  }
  private key(id: string) {
    return `drive-auth:${this.provider}:${id}`;
  }
  private async read(id: string): Promise<SessionRecord> {
    await this.pending.get(id);
    const raw = await this.secrets().get(this.key(id));
    return raw ? JSON.parse(raw) : { headers: {} };
  }
  private async update(
    id: string,
    change: (record: SessionRecord) => SessionRecord,
  ) {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        const raw = await this.secrets().get(this.key(id));
        const record: SessionRecord = raw ? JSON.parse(raw) : { headers: {} };
        await this.secrets().set(this.key(id), JSON.stringify(change(record)));
      });
    this.pending.set(id, task);
    try {
      await task;
    } finally {
      if (this.pending.get(id) === task) this.pending.delete(id);
    }
  }
  async capture(id: string, input: Record<string, string>) {
    const next = Object.fromEntries(
      Object.entries(input)
        .map(([k, v]) => [k.toLowerCase(), v])
        .filter(
          ([k, v]) =>
            (this.provider === "cmcc"
              ? cmccFields
              : (fields as readonly string[])
            ).includes(k) &&
            typeof v === "string" &&
            v.length <= 16000 &&
            !/[\r\n]/.test(v),
        ),
    );
    if (!this.valid(next)) return false;
    await this.update(id, (old) =>
      old.headers.authorization === next.authorization
        ? { ...old, headers: { ...old.headers, ...next } }
        : { headers: next },
    );
    return true;
  }
  async captureRefresh(id: string, candidates: unknown) {
    if (this.provider === "cmcc") return;
    if (!Array.isArray(candidates) || !candidates.length) return;
    await this.update(id, (record) => {
      const token = record.headers.authorization?.replace(/^Bearer /i, "");
      const match = candidates.find(
        (c) =>
          c &&
          typeof c === "object" &&
          c.access_token === token &&
          typeof c.refresh_token === "string" &&
          c.refresh_token.length > 0 &&
          c.refresh_token.length <= 16000 &&
          !/\s/.test(c.refresh_token),
      );
      return match && token
        ? { ...record, refreshToken: match.refresh_token }
        : record;
    });
  }
  async headers(id: string, refresh = false) {
    const record = await this.read(id);
    if (!this.valid(record.headers))
      throw new AppError(
        "AUTH_EXPIRED",
        "请打开该网盘账号的隔离窗口，完成登录并进入“我的云盘”后关闭窗口核验。无需手动复制令牌。",
      );
    if (refresh) {
      const existing = this.refreshing.get(id);
      if (existing) return existing;
      const task = this.refreshHeaders(id).finally(() => {
        if (this.refreshing.get(id) === task) this.refreshing.delete(id);
      });
      this.refreshing.set(id, task);
      return task;
    }
    return { ...record.headers };
  }
  private async refreshHeaders(id: string) {
    if (this.provider === "cmcc")
      throw new AppError(
        "AUTH_EXPIRED",
        "移动云盘会话已过期，请在该账号原登录窗口重新登录并进入个人云盘后核验。",
      );
    const record = await this.read(id);
    if (!record.refreshToken || !record.headers["x-client-id"])
      throw new AppError(
        "AUTH_EXPIRED",
        "该网盘会话已过期，请在原隔离窗口重新登录后核验。",
      );
    const result = await this.transport.json(
      id,
      `https://${providerSpecs[this.provider].apiHosts[1]}/v1/auth/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-client-id": record.headers["x-client-id"],
          ...(record.headers["x-device-id"]
            ? { "x-device-id": record.headers["x-device-id"] }
            : {}),
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: record.headers["x-client-id"],
          refresh_token: record.refreshToken,
        }),
      },
    );
    if (
      result.error_code ||
      (result.error && result.error !== "success") ||
      typeof result.access_token !== "string" ||
      !result.access_token ||
      result.access_token.length > 16000 ||
      /\s/.test(result.access_token)
    )
      throw new AppError(
        "AUTH_EXPIRED",
        "该网盘会话续期未成功，请在原隔离窗口重新登录。",
      );
    const oldAuthorization = record.headers.authorization;
    await this.update(id, (current) =>
      current.headers.authorization === oldAuthorization
        ? {
            headers: {
              ...current.headers,
              authorization: `Bearer ${result.access_token}`,
            },
            refreshToken:
              typeof result.refresh_token === "string" && result.refresh_token
                ? result.refresh_token
                : current.refreshToken,
          }
        : current,
    );
    return { ...(await this.read(id)).headers };
  }
  async clear(id: string) {
    await this.refreshing.get(id)?.catch(() => {});
    await this.pending.get(id)?.catch(() => {});
    this.secrets().remove(this.key(id));
  }
}
