import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { Dialog } from "../ui/Dialog";
import { LogWindow } from "../ui/LogWindow";
import { Button, Empty, LoadingState } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";

export function DriveSyncLogs({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose(): void;
}) {
  const [follow, setFollow] = useState(true);
  const query = useIpcQuery(
    "driveSync.logs",
    { accountId },
    { keepPrevious: true },
  );
  const items = useMemo(
    () => query.data?.map(({ at, ...entry }) => ({ ...entry, createdAt: at })),
    [query.data],
  );
  const error =
    query.error === "不支持此操作。"
      ? "同步日志将在应用后端更新后可用。"
      : query.error;

  return (
    <Dialog
      title="同步日志"
      className="drive-index-log-dialog"
      onClose={onClose}
    >
      <QueryError
        error={error}
        loading={query.loading}
        title="无法读取同步日志"
        onRetry={query.reload}
      />
      {items?.length ? (
        <>
          <LogWindow
            items={items}
            label="网盘同步日志"
            newestFirst
            simple
            follow={follow}
            onFollowChange={setFollow}
          />
          {!follow ? (
            <div className="actions">
              <Button quiet size="compact" onClick={() => setFollow(true)}>
                查看最新
              </Button>
            </div>
          ) : null}
        </>
      ) : !error && query.loading && !items ? (
        <LoadingState compact label="正在读取同步日志…" />
      ) : !error && items ? (
        <Empty compact title="暂无同步日志" icon={ScrollText} />
      ) : null}
    </Dialog>
  );
}
