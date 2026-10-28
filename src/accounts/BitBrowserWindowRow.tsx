import { Fragment } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { Button, Status } from "../ui/primitives";
import {
  BitBrowserDiagnostic,
  environmentPlatformName,
} from "./BitBrowserDiagnostic";
import type {
  BrowserEnvironmentView,
  EnvironmentAccountRef,
} from "../../shared/browser-environments";
import type {
  BitBrowserProfile,
  BitBrowserWindow,
} from "../../shared/bitbrowser";

export function BitBrowserWindowRow({
  profile,
  environment,
  localReady,
  connector,
  readAt,
  pending,
  listError,
  expanded,
  failure,
  onOpen,
  onAccounts,
  onImport,
  onToggle,
  onClose,
}: {
  profile: BitBrowserWindow;
  environment?: BrowserEnvironmentView;
  localReady: boolean;
  connector: string;
  readAt: string;
  pending: string;
  listError: boolean;
  expanded: boolean;
  failure: string;
  onOpen(account?: EnvironmentAccountRef): void;
  onAccounts(environmentId: string): void;
  onImport(
    profile: BitBrowserProfile & { connectorKey: string },
    trigger: HTMLButtonElement,
  ): void;
  onToggle(): void;
  onClose(): void;
}) {
  const connectorMatches =
    !environment?.connectorKey || environment.connectorKey === connector;
  const disabled = !!pending || !localReady || !connectorMatches || listError;
  return (
    <Fragment>
      <tr>
        <td>
          <span className="bit-window-sequence">
            {profile.seq === null ? "—" : `#${profile.seq}`}
          </span>
          <strong>{profile.name}</strong>
          <small className="bit-profile-id" title={profile.id}>
            {profile.id}
          </small>
        </td>
        <td>
          <span>
            {profile.groupName ||
              (profile.groupId ? `分组 ${profile.groupId}` : "未分组")}
          </span>
          <small className="bit-window-remark" title={profile.remark}>
            {profile.remark || "暂无备注"}
          </small>
        </td>
        <td>
          <Status
            kind={
              profile.running === null
                ? "warning"
                : profile.running
                  ? "good"
                  : "normal"
            }
          >
            {profile.running === null
              ? "状态未知"
              : profile.running
                ? "运行中"
                : "未运行"}
          </Status>
          {environment?.busy ? (
            <small className="warning-text">业务任务占用中</small>
          ) : null}
        </td>
        <td>
          {!localReady ? (
            <span className="muted">接入状态待读取</span>
          ) : environment ? (
            <>
              <strong>{environment.name}</strong>
              <small>
                {connectorMatches ? "已接入盘序" : "原比特连接不一致"}
              </small>
              <small>
                {environment.accounts.length
                  ? environment.accounts
                      .map(
                        (account) =>
                          `${environmentPlatformName(account.platform)} · ${account.alias}`,
                      )
                      .join("；")
                  : "尚未关联平台账号"}
              </small>
            </>
          ) : (
            <span className="muted">未接入盘序</span>
          )}
        </td>
        <td>
          <div className="bit-window-actions">
            <Button
              quiet
              size="compact"
              disabled={disabled || environment?.busy}
              onClick={() => onOpen()}
            >
              <ExternalLink size={13} />
              {pending === profile.id ? "处理中…" : "打开窗口"}
            </Button>
            {environment ? (
              <Button
                quiet
                size="compact"
                disabled={!connectorMatches}
                onClick={() => onAccounts(environment.id)}
              >
                关联账号
              </Button>
            ) : (
              <Button
                size="compact"
                disabled={disabled}
                onClick={(event) =>
                  onImport(
                    { ...profile, connectorKey: connector },
                    event.currentTarget,
                  )
                }
              >
                接入盘序
              </Button>
            )}
            <Button
              quiet
              size="compact"
              aria-expanded={expanded}
              aria-controls={`bit-diagnostic-${profile.id}`}
              onClick={onToggle}
            >
              {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              详情 / 诊断
            </Button>
            <Button
              quiet
              size="compact"
              disabled={
                disabled || profile.running === false || environment?.busy
              }
              onClick={onClose}
            >
              关闭窗口
            </Button>
          </div>
          {failure ? (
            <p role="alert" className="danger-text bit-window-failure">
              {failure}
            </p>
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="bit-window-detail-row">
          <td colSpan={5} id={`bit-diagnostic-${profile.id}`}>
            <BitBrowserDiagnostic
              profile={profile}
              command={{ profileId: profile.id, connectorKey: connector }}
              environment={environment}
              readAt={readAt}
              pending={disabled}
              onOpenAccount={onOpen}
              onAccounts={() => environment && onAccounts(environment.id)}
            />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}
