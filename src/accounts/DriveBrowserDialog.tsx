import { useRef, useState } from "react";
import type { Account } from "../../shared/types";
import type { DriveBrowserPreview } from "../../shared/drive-browser";
import { ipc } from "../api/client";
import { useAppActions, useAppActivity, useAppData } from "../state";
import { Dialog } from "../ui/Dialog";
import { Button, Notice } from "../ui/primitives";
import { useAccountOperations } from "./useAccountOperations";
import { DriveBrowserIdentity } from "./DriveBrowserIdentity";
import "./drive-browser-binding.css";

export function DriveBrowserDialog({
  account,
  onClose,
}: {
  account: Account;
  onClose(): void;
}) {
  const { data } = useAppData(),
    { command } = useAppActions(),
    { busy } = useAppActivity();
  const { run } = useAccountOperations();
  const latest = data?.accounts.find((a) => a.id === account.id) ?? account;
  const [confirmBackground, setConfirmBackground] = useState(false);
  const [preview, setPreview] = useState<DriveBrowserPreview | null>(null);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<
    "preview" | "refresh" | "background" | null
  >(null);
  const lock = useRef(false);
  const disabled = busy > 0 || phase !== null;
  const perform = async (
    next: NonNullable<typeof phase>,
    action: () => Promise<void>,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setPhase(next);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally {
      lock.current = false;
      setPhase(null);
    }
  };
  const browser = latest.browser;
  return (
    <Dialog
      title="百度网盘 · 指纹浏览器管理"
      className="drive-browser-dialog"
      busy={disabled}
      onClose={onClose}
      footer={
        <>
          <Button disabled={disabled} onClick={onClose}>
            关闭
          </Button>
          {preview ? (
            <Button
              primary
              disabled={disabled}
              onClick={() =>
                void perform("refresh", async () => {
                  const result = await command(
                    "driveBrowser.bind",
                    { token: preview.token },
                    {
                      text: "当前环境核验已更新。请在后台模式核验登录。",
                      tone: "info",
                    },
                  );
                  if (result) setPreview(null);
                })
              }
            >
              {phase === "refresh" ? "正在更新…" : "更新当前环境核验"}
            </Button>
          ) : null}
        </>
      }
    >
      <p className="drive-browser-intro">
        <strong>{latest.alias}</strong>{" "}
        创建时已固定使用比特指纹浏览器，浏览器方式和所选配置不能更换。
        此环境可供贴吧、知道共用，日常请求在同一后台串行执行。
      </p>
      {browser ? (
        <section className="drive-browser-current" aria-label="固定的指纹环境">
          <strong>比特环境：{browser.profileName}</strong>
          <p>
            已记录出口 {browser.exitIp} ·{" "}
            {browser.requireProxy ? "要求代理" : "使用环境网络"}
          </p>
          <div className="drive-browser-controls">
            <Button
              size="compact"
              disabled={disabled || !latest.enabled}
              onClick={() => {
                setConfirmBackground((v) => !v);
                setPreview(null);
              }}
            >
              转为后台运行
            </Button>
            <Button
              size="compact"
              disabled={disabled || !latest.enabled}
              onClick={() => void run(latest, "login")}
            >
              打开登录窗口
            </Button>
            <Button
              size="compact"
              disabled={disabled || !latest.enabled}
              onClick={() => void run(latest, "verify")}
            >
              核验后台登录
            </Button>
          </div>
          {confirmBackground ? (
            <div className="drive-browser-detach">
              <p>
                将关闭“{browser.profileName}
                ”的全部可见窗口（包括共用的贴吧、知道网页）并在后台启动。请先保存未提交的网页内容；已保存登录信息和网盘文件保留。
              </p>
              <Button
                size="compact"
                disabled={disabled}
                onClick={() => setConfirmBackground(false)}
              >
                取消
              </Button>
              <Button
                size="compact"
                disabled={disabled}
                onClick={() =>
                  void perform("background", async () => {
                    const result = await command(
                      "driveBrowser.background",
                      { accountId: latest.id, confirmed: true },
                      {
                        text: "指定环境已转为后台，请核验后台登录。",
                        tone: "info",
                      },
                    );
                    if (result) setConfirmBackground(false);
                  })
                }
              >
                {phase === "background"
                  ? "正在转为后台…"
                  : "关闭窗口并转为后台"}
              </Button>
            </div>
          ) : null}
          <div className="drive-browser-detach">
            <p>
              原环境重新登录或代理出口、指纹配置发生变化时，可重新核对同一环境的
              UID 和出口，不能改绑其他配置。
            </p>
            <Button
              size="compact"
              disabled={disabled || !latest.enabled}
              onClick={() =>
                void perform("preview", async () => {
                  setPreview(null);
                  const result = await ipc("driveBrowser.preview", {
                    accountId: latest.id,
                    profileId: browser.profileId,
                    connectorKey: data!.settings.bitUrl,
                    requireProxy: browser.requireProxy,
                  });
                  setPreview(result);
                })
              }
            >
              {phase === "preview" ? "正在读取当前环境…" : "读取当前环境信息"}
            </Button>
          </div>
        </section>
      ) : (
        <Notice danger>
          固定的指纹环境记录缺失，请恢复原工作空间备份。此账号不会切回内置浏览器。
        </Notice>
      )}
      {error ? <Notice danger>{error}</Notice> : null}
      {preview ? <DriveBrowserIdentity preview={preview} /> : null}
    </Dialog>
  );
}
