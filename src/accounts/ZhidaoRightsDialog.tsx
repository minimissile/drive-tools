import type { OtherAccount } from "./useOtherAccounts";
import { Dialog } from "../ui/Dialog";
import { Button, Notice } from "../ui/primitives";

export function ZhidaoRightsDialog({
  account,
  busy,
  error,
  onClose,
  onOpen,
  onCheck,
  onAutomate,
}: {
  account: OtherAccount;
  busy: boolean;
  error?: string;
  onClose(): void;
  onOpen(page: "answer" | "quota"): void;
  onCheck(): void;
  onAutomate(): void;
}) {
  return (
    <Dialog title="获取百度知道发布权益" onClose={onClose} busy={busy}>
      <p>当前账号：{account.alias}。官方页面将使用此账号独立的登录会话。</p>
      <ol>
        <li>在盘序配置自动答题，或前往官方活动页手动回答。</li>
        <li>等待平台审核，在答主工作台查看通过情况和发布额度。</li>
        <li>完成后返回盘序，重新检查资格。</li>
      </ol>
      <Notice warning>
        答题提交不等于审核通过。开通条件、审核时间与额度以百度官方页面为准。
      </Notice>
      {error ? <Notice danger>{error}</Notice> : null}
      <div className="actions">
        <Button primary disabled={busy} onClick={onAutomate}>
          配置自动答题
        </Button>
        <Button disabled={busy} onClick={() => onOpen("answer")}>
          打开官方答题页
        </Button>
        <Button disabled={busy} onClick={() => onOpen("quota")}>
          查看发布额度
        </Button>
        <Button disabled={busy} onClick={onCheck}>
          重新检查资格
        </Button>
      </div>
    </Dialog>
  );
}
