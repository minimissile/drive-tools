import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { landingTrafficChannelNames } from "../../shared/landing-traffic";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { QueryError } from "../ui/QueryError";
import { Button, LoadingState } from "../ui/primitives";

export function LandingTrafficPanel({
  resourceId,
  pageUrl,
  published,
}: {
  resourceId: string;
  pageUrl: string | null;
  published: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { notify } = useAppActions();
  const query = useIpcQuery(
    "resourceLanding.traffic",
    { resourceId },
    {
      enabled: open && published,
      keepPrevious: true,
    },
  );
  const origin = pageUrl ? new URL(pageUrl).origin : null;
  const external = async (url: string) => {
    try {
      await ipc("system.external", { url });
    } catch {
      notify("站长工具未能打开，请稍后重试。", "error");
    }
  };
  return (
    <section className="landing-traffic">
      <h3>访问与获取</h3>
      {!published ? (
        <p className="landing-editor-help">
          发布后开始记录匿名访问与网盘入口点击。
        </p>
      ) : (
        <details onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>查看近28天数据</summary>
          {open ? (
            <>
              <QueryError
                title="访问统计读取失败"
                error={query.error}
                loading={query.loading}
                onRetry={query.reload}
              />
              {!query.data && query.loading ? (
                <LoadingState label="正在读取访问统计…" />
              ) : null}
              {query.data ? (
                <>
                  <dl className="landing-traffic-totals">
                    <div>
                      <dt>页面访问</dt>
                      <dd>{query.data.totals.views}</dd>
                    </div>
                    <div>
                      <dt>前往网盘</dt>
                      <dd>{query.data.totals.outbound}</dd>
                    </div>
                    <div>
                      <dt>复制成功</dt>
                      <dd>{query.data.totals.copies}</dd>
                    </div>
                  </dl>
                  {query.data.channels.length ? (
                    <table className="landing-traffic-channels">
                      <caption>可识别的访问来源</caption>
                      <thead>
                        <tr>
                          <th scope="col">来源</th>
                          <th scope="col">访问</th>
                          <th scope="col">网盘</th>
                        </tr>
                      </thead>
                      <tbody>
                        {query.data.channels.map((row) => (
                          <tr key={row.channel}>
                            <th scope="row">
                              {landingTrafficChannelNames[row.channel]}
                            </th>
                            <td>{row.views}</td>
                            <td>{row.outbound}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="landing-editor-help">
                      统计已启用，当前时间范围内还没有记录。
                    </p>
                  )}
                  <p className="landing-editor-help">
                    从 {query.data.trackingSince.slice(0, 10)}{" "}
                    起记录，按UTC日汇总。访问不等于独立访客，网盘点击不等于下载成功；隐私保护或来源丢失可能导致少计。
                  </p>
                  <Button
                    size="compact"
                    quiet
                    disabled={query.loading}
                    onClick={query.reload}
                  >
                    {query.loading ? "正在刷新…" : "刷新数据"}
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </details>
      )}
      <p className="landing-editor-help">
        搜索展示、关键词和排名以站长工具为准；AI来源访问不等于已获AI引用。
      </p>
      {origin ? (
        <div className="landing-traffic-tools">
          <Button
            size="compact"
            quiet
            onClick={() =>
              void external(
                `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(`sc-domain:${new URL(origin).hostname}`)}`,
              )
            }
          >
            <ExternalLink size={12} />
            Google
          </Button>
          <Button
            size="compact"
            quiet
            onClick={() =>
              void external(
                `https://www.bing.com/webmasters/searchperf?siteUrl=${encodeURIComponent(origin + "/")}`,
              )
            }
          >
            <ExternalLink size={12} />
            Bing
          </Button>
        </div>
      ) : null}
    </section>
  );
}
