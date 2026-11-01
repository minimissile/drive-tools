import { useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import {
  photoPlatformNames,
  photoPublicationText,
  type PhotoPost,
  type PhotoPlatform,
} from "../../shared/photo-posts";
import { providers } from "../../shared/platforms";
import { Button, Field, Notice, Panel, Status } from "../ui/primitives";
import { ipc } from "../api/client";
import { useAppActions } from "../state";
export function PhotoPublishing({
  post,
  dirty,
  onSaved,
}: {
  post: PhotoPost;
  dirty: boolean;
  onSaved(post: PhotoPost): void;
}) {
  const [platform, setPlatform] = useState<PhotoPlatform>(
    post.form.platforms[0],
  );
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { notify } = useAppActions();
  const current = post.publications.find(
    (p) => p.platform === platform && p.version === post.version,
  );
  const ready = !dirty && post.exportedVersion === post.version;
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="平台发布" extra={<small>官网上传提交 · 回填实际结果</small>}>
      <div
        className="photo-post-platforms"
        role="group"
        aria-label="查看平台文案"
      >
        {post.form.platforms.map((p) => (
          <Button
            key={p}
            quiet={platform !== p}
            size="compact"
            aria-pressed={platform === p}
            onClick={() => {
              setPlatform(p);
              setUrl("");
              setError("");
            }}
          >
            {photoPlatformNames[p]}
          </Button>
        ))}
      </div>
      <textarea
        aria-label="发布文案预览"
        className="photo-post-copy"
        value={photoPublicationText(
          post.form,
          providers[post.provider],
          platform,
        )}
        readOnly
        rows={6}
      />
      <div className="photo-post-actions">
        <Button
          size="compact"
          disabled={dirty || busy}
          onClick={() =>
            void run(async () => {
              await ipc("system.copyText", {
                text: photoPublicationText(
                  post.form,
                  providers[post.provider],
                  platform,
                ),
              });
              notify("已复制当前平台文案。", "success");
            })
          }
        >
          <Copy size={14} />
          复制文案
        </Button>
        <Button
          size="compact"
          disabled={!ready || busy}
          onClick={() =>
            void run(async () => {
              onSaved(
                await ipc("photoPosts.open", {
                  id: post.id,
                  version: post.version,
                  platform,
                }),
              );
              notify("已打开平台官网，请核对账号后上传并发布。", "info");
            })
          }
        >
          <ExternalLink size={14} />
          打开{photoPlatformNames[platform]}发布页
        </Button>
        {current ? (
          <Status kind={current.status === "published" ? "good" : "normal"}>
            {current.status === "opened"
              ? "已打开官网"
              : current.status === "submitted"
                ? "已提交 · 待审核"
                : "已确认公开"}
          </Status>
        ) : null}
      </div>
      {!ready ? (
        <p className="muted">保存修改并核验导出当前版本后，可打开发布页。</p>
      ) : (
        <p className="muted">
          每个平台保留独立登录会话。请在官网完成账号核对、图片上传与提交；打开网页不会记为已发布。
        </p>
      )}
      {current ? (
        <div className="photo-post-result">
          <Field label="实际作品地址">
            <input
              aria-label="实际作品地址"
              value={url || current.url || ""}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="粘贴发布后的完整作品地址"
            />
          </Field>
          <div className="photo-post-actions">
            {(["submitted", "published"] as const).map((status) => (
              <Button
                key={status}
                size="compact"
                disabled={
                  busy ||
                  dirty ||
                  !(url || current.url) ||
                  (current.status === "published" && status === "submitted")
                }
                onClick={() =>
                  void run(async () => {
                    onSaved(
                      await ipc("photoPosts.result", {
                        id: post.id,
                        version: post.version,
                        platform,
                        status,
                        url: url || current.url || "",
                      }),
                    );
                    notify(
                      status === "submitted"
                        ? "已记录待审核结果。"
                        : "已记录人工确认公开。",
                      "success",
                    );
                  })
                }
              >
                {status === "submitted" ? "记录已提交 · 待审核" : "确认已公开"}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {error ? <Notice danger>{error}</Notice> : null}
      {post.publications.some((p) => p.version !== post.version) ? (
        <details>
          <summary>历史版本发布记录</summary>
          {post.publications
            .filter((p) => p.version !== post.version)
            .map((p) => (
              <p key={`${p.platform}:${p.version}`}>
                {photoPlatformNames[p.platform]} · v{p.version} · {p.status}{" "}
                {p.url}
              </p>
            ))}
        </details>
      ) : null}
    </Panel>
  );
}
