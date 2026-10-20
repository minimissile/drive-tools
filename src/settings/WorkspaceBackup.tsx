import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { useAppActions, useAppActivity, useAppData } from "../state";
import { Button, Notice, Panel } from "../ui/primitives";
import { formatTime } from "../lib/format";
import type { BackupPreview } from "../../shared/types";

export function WorkspaceBackup() {
  const { data } = useAppData();
  const { command, notify } = useAppActions();
  const { busy } = useAppActivity();
  const [backupPreview, setBackupPreview] = useState<BackupPreview | null>(
      null,
    ),
    [restoreAck, setRestoreAck] = useState(false);
  return (
    <Panel title="本地数据与备份">
      <div className="settings-backup-path">
        <span>当前工作空间</span>
        <code>{data!.dataPath}</code>
        <div>
          <Button onClick={() => void command("system.dataFolder")}>
            <FolderOpen size={14} />
            打开数据目录
          </Button>
        </div>
      </div>
      <div className="settings-backup-group">
        <h3>导出备份</h3>
        <p>
          备份包括 SQLite 快照和封面附件，排除网盘登录态与 API
          Key。升级前建议保留一份；不会联动删除网盘文件。
        </p>
        <Button
          disabled={busy > 0}
          onClick={async () => {
            const folder = await command("system.backup");
            if (folder)
              notify(
                `备份已保存到：${folder}。不含网盘登录态和API Key。`,
                "success",
              );
          }}
        >
          导出一致性备份
        </Button>
      </div>
      <div className="settings-backup-group">
        <h3>从备份恢复</h3>
        <p>先选择备份检查内容，再确认恢复到新工作空间。</p>
        <div className="row">
          <Button
            disabled={busy > 0}
            onClick={async () => {
              setBackupPreview(null);
              setRestoreAck(false);
              const preview = await command("system.backupPreview");
              if (preview) setBackupPreview(preview);
            }}
          >
            选择备份并预检
          </Button>
          {data!.settings.previousWorkspace ? (
            <Button
              disabled={busy > 0}
              onClick={() => void command("system.previousWorkspace")}
            >
              切回恢复前工作空间
            </Button>
          ) : null}
        </div>
      </div>
      {backupPreview ? (
        <div className="settings-backup-preview">
          <h3>备份预检通过</h3>
          <p className="break-word">{backupPreview.folder}</p>
          <p>创建于 {formatTime(backupPreview.createdAt)}</p>
          <dl className="settings-backup-counts">
            {[
              ["资源", backupPreview.resources],
              ["账号", backupPreview.accounts],
              ["草稿", backupPreview.drafts],
              ["封面", backupPreview.covers],
            ].map(([name, count]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
          <Notice>
            恢复会建立新工作空间，保留当前数据。恢复后需要重新登录网盘、配置 API
            Key 和
            Vault、复核分享及草稿；未完成任务暂停，避免重复转存。新空间的每日 AI
            预算默认设为 0。
          </Notice>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={restoreAck}
              onChange={(e) => setRestoreAck(e.target.checked)}
            />
            已保存正在编辑的内容，同意恢复到新工作空间并重启
          </label>
          <Button
            primary
            disabled={!restoreAck || busy > 0}
            onClick={() =>
              void command("system.restore", {
                token: backupPreview.token,
                confirmed: true,
              })
            }
          >
            恢复到新工作空间并重启
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
