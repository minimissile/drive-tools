import { ArrowDownToLine, ArrowUp, ExternalLink } from "lucide-react";
import type { Provider, RemoteFile, ShareInspection } from "../../shared/types";
import { FileTable } from "../drive-files/FileTable";
import {
  Button,
  Empty,
  Loading,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";

export interface ShareParent {
  id: string;
  name: string;
}
export function SourceContents({
  inspection,
  provider,
  selected,
  parents,
  loading,
  error,
  enabled,
  own,
  onRead,
  onOpenOfficial,
  onSelect,
}: {
  inspection: ShareInspection | null;
  provider: Provider;
  selected: RemoteFile[];
  parents: ShareParent[];
  loading: boolean;
  error: string;
  enabled: boolean;
  own: boolean;
  onRead(
    parentId?: string,
    page?: number,
    cursor?: string,
    parents?: ShareParent[],
  ): void;
  onOpenOfficial(): void;
  onSelect(files: RemoteFile[]): void;
}) {
  const otherDirectory =
    !!selected.length &&
    !!inspection &&
    selected[0].parentId !== inspection.files[0]?.parentId;
  return (
    <Panel
      title={own ? "查看资源分享内容" : "查看内容并选择转存文件"}
      extra={
        <div className="row">
          <Button quiet disabled={!enabled || loading} onClick={onOpenOfficial}>
            <ExternalLink size={14} />
            打开官方分享
          </Button>
          <Button
            disabled={!enabled || loading}
            onClick={() =>
              onRead("0", 1, undefined, [{ id: "0", name: "分享根目录" }])
            }
          >
            <ArrowDownToLine size={14} />
            {loading ? "正在读取…" : "读取分享内容"}
          </Button>
        </div>
      }
    >
      <small>
        {own
          ? "可查看目录和文件信息；下方的本人网盘管理支持修改文件。"
          : "展开文件夹查看资源，可只选需要的文件。转存完成后可管理本人副本、插入或替换广告。"}{" "}
        如需官方验证，请先打开分享完成验证。
      </small>
      <QueryError
        error={error}
        loading={loading}
        onRetry={() => onRead(parents.at(-1)?.id ?? "0", 1, undefined, parents)}
      />
      {inspection ? (
        <>
          <nav className="drive-breadcrumb" aria-label="来源分享目录">
            <Button
              quiet
              disabled={loading || parents.length <= 1}
              onClick={() => {
                const next = parents.slice(0, -1);
                onRead(next.at(-1)!.id, 1, undefined, next);
              }}
            >
              <ArrowUp size={14} />
              上一级
            </Button>
            {parents.map((p, i) => (
              <Button
                key={i}
                quiet
                disabled={loading}
                onClick={() =>
                  onRead(p.id, 1, undefined, parents.slice(0, i + 1))
                }
              >
                {p.name}
              </Button>
            ))}
          </nav>
          {loading ? <Loading label="正在读取目录，保留上次结果…" /> : null}
          {!own && selected.length ? (
            <div className="drive-browser-actions">
              <span>
                待转存：{selected.length} 项
                {otherDirectory ? "（位于其他目录）" : ""}
              </span>
              <Button quiet disabled={loading} onClick={() => onSelect([])}>
                清空选择
              </Button>
            </div>
          ) : null}
          {otherDirectory && !own ? (
            <Notice>
              一次从同一目录选择最多 100
              项。若要改选此目录内的文件，请先清空原选择。
            </Notice>
          ) : null}
          <FileTable
            key={inspection.parentId}
            files={inspection.files}
            selected={selected.map((f) => f.id)}
            disabled={loading}
            selectable={!own && !otherDirectory}
            onSelect={(ids) =>
              onSelect(
                ids
                  .map(
                    (id) =>
                      inspection.files.find((f) => f.id === id) ??
                      selected.find((f) => f.id === id),
                  )
                  .filter((f): f is RemoteFile => !!f),
              )
            }
            onOpen={(f) => {
              const id = provider === "baidu" ? (f.path ?? f.id) : f.id;
              onRead(id, 1, undefined, [...parents, { id, name: f.name }]);
            }}
          />
          {inspection.hasMore ? (
            <Button
              disabled={loading}
              onClick={() =>
                onRead(
                  inspection.parentId,
                  inspection.page + 1,
                  inspection.nextCursor,
                  parents,
                )
              }
            >
              读取更多文件
            </Button>
          ) : null}
        </>
      ) : loading ? (
        <LoadingState label="正在读取分享文件…" layout="list" />
      ) : !error ? (
        <Empty compact title="读取分享后查看目录与文件">
          文件夹可展开浏览，文件可查看名称、大小与路径信息。
        </Empty>
      ) : null}
    </Panel>
  );
}
