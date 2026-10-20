import { Download, Sparkles, Save } from "lucide-react";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { useAppActions } from "../state";

import { ipc } from "../api/client";
import type { ExportModel } from "./useResourceExport";
export function ExportArticle({ model }: { model: ExportModel }) {
  const { command, notify } = useAppActions();

  const {
    run,
    setRun,
    selected,
    article,
    setArticle,
    setWorking,
    mounted,
    locked,
    articleStale,
  } = model;
  if (!run) return null;
  return (
    <Panel title="主题短文" extra={<span className="tag">基于已选资源</span>}>
      <p className="muted">
        按已选资源的分类统计与最多40份详细样本生成介绍短文，保留资源引用，可编辑并保存。
      </p>
      {run.articleError ? (
        <Notice warning>
          {run.articleError}{" "}
          已完成的筛选结果和原有短文仍保留；重试会产生新的模型费用。
        </Notice>
      ) : null}
      <Button
        disabled={locked || run.state !== "completed" || !selected.length}
        onClick={async () => {
          setWorking(true);
          try {
            const r = await command("resourceExport.article", {
              runId: run.id,
              ids: selected,
            });
            if (r) {
              setRun(r);
              setArticle(r.article);
            } else {
              const latest = await ipc("resourceExport.get", { runId: run.id });
              if (mounted.current) setRun(latest);
            }
          } finally {
            setWorking(false);
          }
        }}
      >
        <Sparkles size={14} />
        {article ? "重新生成短文" : "生成主题短文"}
      </Button>
      {article ? (
        <>
          {articleStale ? (
            <Notice warning>资源选择已变化，请重新生成短文后导出。</Notice>
          ) : null}
          <Field label="短文标题">
            <input
              aria-label="短文标题"
              value={article.title}
              maxLength={200}
              onChange={(e) =>
                setArticle({ ...article, title: e.target.value })
              }
            />
          </Field>
          <Field label="短文正文">
            <textarea
              aria-label="短文正文"
              value={article.body}
              maxLength={12000}
              rows={12}
              onChange={(e) => setArticle({ ...article, body: e.target.value })}
            />
          </Field>
          <small>
            请人工核对内容；正文中的 resource:
            引用会在导出时转换为资源名称，并附上资料依据。
          </small>
          <div className="row">
            <Button
              disabled={
                locked ||
                articleStale ||
                !article.title.trim() ||
                !article.body.trim()
              }
              onClick={async () => {
                setWorking(true);
                try {
                  const r = await command(
                    "resourceExport.articleSave",
                    { runId: run.id, article },
                    "短文修改已保存，不调用AI。",
                  );
                  if (r) setRun(r);
                } finally {
                  setWorking(false);
                }
              }}
            >
              <Save size={14} />
              保存短文修改
            </Button>
            {(["md", "txt"] as const).map((f) => (
              <Button
                key={f}
                disabled={
                  locked ||
                  articleStale ||
                  !article.title.trim() ||
                  !article.body.trim()
                }
                onClick={async () => {
                  setWorking(true);
                  try {
                    const path = await command("resourceExport.articleFile", {
                      runId: run.id,
                      article,
                      format: f,
                    });
                    if (path) notify(`短文已导出：${path}`, "success");
                  } finally {
                    setWorking(false);
                  }
                }}
              >
                <Download size={14} />
                导出 {f.toUpperCase()} 短文
              </Button>
            ))}
          </div>
        </>
      ) : null}
    </Panel>
  );
}
