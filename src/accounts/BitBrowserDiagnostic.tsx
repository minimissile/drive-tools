import { useIpcQuery } from "../api/useIpcQuery";
import {
  Button,
  Empty,
  Loading,
  LoadingState,
  Notice,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { formatTime } from "../lib/format";
import type {
  BitBrowserWindow,
  BitProfileCommand,
} from "../../shared/bitbrowser";
import type {
  BrowserEnvironmentView,
  EnvironmentAccountRef,
} from "../../shared/browser-environments";
import { platformSpecs } from "../../shared/platforms";
import {
  documentPlatformSpecs,
  isDocumentProvider,
} from "../../shared/document-platforms";

export const environmentPlatformName = (platform: string) =>
  (isDocumentProvider(platform)
    ? documentPlatformSpecs[platform].name
    : undefined) ??
  { "baidu-marketing": "百度营销", "baidu-zhidao": "百度知道", "drive-baidu": "百度网盘" }[platform] ??
  platformSpecs.find((spec) => spec.id === platform)?.name ??
  platform;

export function BitBrowserDiagnostic({
  profile,
  command,
  environment,
  readAt,
  pending,
  onOpenAccount,
  onAccounts,
}: {
  profile: BitBrowserWindow;
  command: BitProfileCommand;
  environment?: BrowserEnvironmentView;
  readAt: string;
  pending: boolean;
  onOpenAccount(ref: EnvironmentAccountRef): void;
  onAccounts(): void;
}) {
  const query = useIpcQuery("bit.diagnose", command, {
    keepPrevious: true,
    revision: JSON.stringify([
      environment?.revision,
      environment?.busy,
      environment?.accounts,
      readAt,
    ]),
  });
  const config = query.data?.configuration;
  const network = environment?.network;
  const issues = [
    ...(query.data?.configurationError ? [query.data.configurationError] : []),
    ...(config?.dynamicIp
      ? [
          "比特配置启用了打开时更换 IP，盘序业务会暂停使用；请在比特客户端关闭后重试。",
        ]
      : []),
    ...(config?.randomFingerprint
      ? ["此配置每次启动会随机指纹，请在比特客户端改用稳定指纹。"]
      : []),
    ...(environment?.requireProxy &&
    config &&
    (config.proxyType === "noproxy" || !config.stopWhileNetError)
      ? [
          "当前环境要求独立代理，请在比特客户端配置代理，并开启网络异常停止打开。",
        ]
      : []),
    ...(query.data?.blockers ?? []),
  ];
  return (
    <div className="bit-diagnostic" aria-label={`${profile.name}窗口诊断`}>
      <div className="row spread">
        <h3>窗口详情与诊断</h3>
        <Button
          quiet
          size="compact"
          disabled={query.loading}
          onClick={query.reload}
        >
          重新检查配置
        </Button>
      </div>
      <p className="muted bit-profile-id">配置 ID：{profile.id}</p>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
        title="暂时无法读取窗口诊断"
      />
      {!query.data && !query.error ? (
        <LoadingState compact label="正在读取窗口配置和本地账号状态…" />
      ) : null}
      {query.loading && query.data ? <Loading label="正在刷新诊断…" /> : null}
      {query.data ? (
        <>
          {issues.length ? (
            <Notice warning>{[...new Set(issues)].join(" ")}</Notice>
          ) : null}
          <dl className="bit-diagnostic-facts">
            <div>
              <dt>浏览器运行</dt>
              <dd>
                {profile.running === null
                  ? "状态未知，请刷新窗口列表"
                  : profile.running
                    ? "运行中"
                    : "未运行"}
              </dd>
            </div>
            <div>
              <dt>业务任务</dt>
              <dd>
                {environment?.busy ? "执行中或排队中" : "当前无环境任务占用"}
              </dd>
            </div>
            <div>
              <dt>比特代理</dt>
              <dd>
                {config
                  ? config.proxyType === "noproxy"
                    ? "本机网络"
                    : `${config.proxyType.toUpperCase()} · ${config.proxyHost || "由比特管理"}${config.proxyPort ? `:${config.proxyPort}` : ""}`
                  : "配置暂不可读"}
              </dd>
            </div>
            <div>
              <dt>环境出口</dt>
              <dd>
                {network && network.revision === environment?.revision
                  ? `${network.ip} · ${formatTime(network.checkedAt)}`
                  : "尚无当前配置的有效检查记录"}
              </dd>
            </div>
            <div>
              <dt>设备与内核</dt>
              <dd>
                {config
                  ? [
                      config.os,
                      config.coreVersion && `内核 ${config.coreVersion}`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "客户端未提供"
                  : "暂不可读"}
              </dd>
            </div>
            <div>
              <dt>配置检查</dt>
              <dd>{formatTime(query.data.checkedAt)} · 不代表平台已登录</dd>
            </div>
          </dl>
          {profile.remark ? (
            <p className="bit-profile-remark">比特备注：{profile.remark}</p>
          ) : null}
          {query.data.pendingOperations.length ? (
            <Notice warning>
              关闭前请核对已有操作：{query.data.pendingOperations.join("；")}。
            </Notice>
          ) : null}
          <div className="row spread">
            <h3>关联的平台账号</h3>
            {environment ? (
              <Button quiet size="compact" onClick={onAccounts}>
                管理关联账号
              </Button>
            ) : null}
          </div>
          {query.data.accounts.length ? (
            <div className="bit-diagnostic-accounts">
              {query.data.accounts.map((account) => (
                <div
                  className="bit-diagnostic-account"
                  key={`${account.kind}:${account.id}`}
                >
                  <div>
                    <strong>
                      {environmentPlatformName(account.platform)} ·{" "}
                      {account.alias}
                    </strong>
                    <small>
                      {account.uid ? `UID ${account.uid} · ` : ""}
                      {account.message}
                    </small>
                  </div>
                  <Status
                    kind={account.status === "verified" ? "good" : "warning"}
                  >
                    {account.status === "verified"
                      ? "上次身份核验有效"
                      : account.status === "expired"
                        ? "需重新登录"
                        : "身份待核验"}
                  </Status>
                  <Button
                    quiet
                    size="compact"
                    disabled={
                      pending ||
                      environment?.busy ||
                      !!query.data?.blockers.length
                    }
                    onClick={() => onOpenAccount(account)}
                  >
                    打开平台
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              compact
              title={environment ? "尚未关联平台账号" : "尚未接入盘序"}
            >
              {environment
                ? "关联账号后，可在这里查看核验状态并打开对应平台。"
                : "先从窗口列表接入，再关联平台账号。"}
            </Empty>
          )}
        </>
      ) : null}
    </div>
  );
}
