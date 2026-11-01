import { Search } from "lucide-react";
import { z } from "zod";
import { useAppData } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import type { PageDiscoveryInput } from "../../shared/zhidao-page-discovery";
const example =
  "https://zhidao.baidu.com/question/1811441075743285707/answer/5013312792.html";
const lines = (text: string) => [
  ...new Set(
    text
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];
export function PageDiscoverySetup({
  running,
  busy,
  error,
  start,
}: {
  running: boolean;
  busy: boolean;
  error: string;
  start(input: PageDiscoveryInput): void;
}) {
  const { data } = useAppData();
  const draft = useLocalDraft(
    `panxu-zhidao-page-discovery:${data!.dataPath}`,
    { keywords: "小提琴教程", urls: "", pages: 2, limit: 50, intervalMs: 2000 },
    (v) =>
      z
        .object({
          keywords: z.string().max(5000),
          urls: z.string().max(100000),
          pages: z.number(),
          limit: z.number(),
          intervalMs: z.number(),
        })
        .parse(v),
  );
  return (
    <Panel
      title="检索范围"
      className="page-discovery-config"
      extra={<span className="page-discovery-hint">公开页面 · 不调用AI</span>}
    >
      <div className="page-discovery-form">
        <Field
          label="批量关键词"
          hint="每行一个，最多20个；通过百度限定站点检索"
        >
          <textarea
            aria-label="批量检索关键词"
            rows={4}
            value={draft.value.keywords}
            disabled={running || busy}
            onChange={(e) => draft.update({ keywords: e.target.value })}
            placeholder="例如：小提琴教程&#10;Excel项目进度表"
          />
        </Field>
        <div className="page-discovery-options">
          <div className="page-discovery-numbers">
            <Field label="每词检索页数" hint="1–5页">
              <input
                aria-label="每词检索页数"
                type="number"
                min={1}
                max={5}
                value={draft.value.pages}
                disabled={running || busy}
                onChange={(e) =>
                  draft.update({ pages: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="目标回答页数" hint="1–200个，达到后停止">
              <input
                aria-label="目标回答页数"
                type="number"
                min={1}
                max={200}
                value={draft.value.limit}
                disabled={running || busy}
                onChange={(e) =>
                  draft.update({ limit: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="读取间隔（秒）" hint="1–10秒，逐页读取">
              <input
                aria-label="读取间隔（秒）"
                type="number"
                min={1}
                max={10}
                value={draft.value.intervalMs / 1000}
                disabled={running || busy}
                onChange={(e) =>
                  draft.update({ intervalMs: Number(e.target.value) * 1000 })
                }
              />
            </Field>
          </div>
          <details>
            <summary>直接检查页面（可选）</summary>
            <Field
              label="问题页或回答页"
              hint="每行一个，最多100个；结果会标记为指定页面"
            >
              <textarea
                aria-label="指定检查页面"
                rows={3}
                value={draft.value.urls}
                disabled={running || busy}
                onChange={(e) => draft.update({ urls: e.target.value })}
                placeholder={example}
              />
            </Field>
          </details>
        </div>
      </div>
      {error || draft.error ? (
        <Notice danger>{error || draft.error}</Notice>
      ) : null}
      <div className="page-discovery-actions">
        <Button
          primary
          disabled={running || busy}
          onClick={() =>
            start({
              ...draft.value,
              keywords: lines(draft.value.keywords),
              urls: lines(draft.value.urls),
            })
          }
        >
          <Search size={15} />
          开始发现回答页
        </Button>
        <Button
          disabled={running || busy}
          onClick={() =>
            start({
              keywords: [],
              urls: [example],
              pages: 1,
              limit: 20,
              intervalMs: 2000,
            })
          }
        >
          检查示例页
        </Button>
        <span>
          只统计回答正文命中的页面；搜索摘要、问题描述和推荐区不计入。
        </span>
      </div>
      <details className="page-discovery-script">
        <summary>独立脚本与执行方式</summary>
        <code>
          node --import tsx scripts/discover-zhidao-pages.ts --keyword
          "小提琴教程" --pages 2 --out /tmp/zhidao-pages.json
        </code>
        <p>
          页面与脚本共用解析及去重逻辑。桌面页使用独立后台浏览器读取，脚本使用HTTP；遇到安全验证暂停，网盘链接有效性未核验。
        </p>
      </details>
    </Panel>
  );
}
