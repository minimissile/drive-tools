import { useState } from "react";
import { Check, Copy, Download, ExternalLink, Settings2 } from "lucide-react";
import { useApp } from "../state";
import {
  Button,
  Cover,
  Empty,
  Field,
  Header,
  Notice,
  Panel,
  ResourcePicker,
  ResourceRequired,
  accountLabel,
  formatTime,
} from "../components";
import { platformSpecs } from "../../shared/platforms";
export default function Publish() {
  const { data, copy, resource, command, navigate, busy, notify } = useApp();
  const [draftId, setDraftId] = useState(
      () => localStorage.getItem("panxu-publish-draft") ?? "",
    ),
    [bindingId, setBindingId] = useState(""),
    [includeLink, setIncludeLink] = useState(false),
    [publishedUrl, setPublishedUrl] = useState("");
  const drafts = data!.drafts.filter((d) => d.copyId === copy?.id),
    draft = drafts.find((d) => d.id === draftId) ?? drafts[0],
    spec = platformSpecs.find((p) => p.id === draft?.platform);
  const bindings = data!.bindings.filter((b) => b.platform === draft?.platform),
    binding = bindings.find((b) => b.id === bindingId) ?? bindings[0];
  const opened = data!.publications.some(
    (p) =>
      p.draftId === draft?.id &&
      p.draftVersion === draft?.version &&
      p.bindingId === binding?.id &&
      p.status === "opened",
  );
  const ownReady =
    copy?.status === "ready" && !!copy.shareUrl && !!copy.shareVerifiedAt;
  const copyText = async () => {
    const result = await command<{ text: string }>("publication.package", {
      draftId: draft!.id,
      bindingId: binding?.id ?? null,
      includeLink,
    });
    if (result)
      await command(
        "system.copyText",
        { text: result.text },
        "当前内容包已核验并复制。",
      );
  };
  return (
    <>
      <Header
        title="准备好内容，再打开正确的窗口。"
        description="复制素材 → 打开比特指定窗口 → 人工发布 → 回填内容链接。"
      />
      <ResourceRequired>
        <ResourcePicker />
        {draft ? (
          <>
            <div className="toolbar">
              <select
                aria-label="待发布草稿"
                className="grow"
                value={draft.id}
                onChange={(e) => {
                  setDraftId(e.target.value);
                  setBindingId("");
                  setIncludeLink(false);
                }}
              >
                {drafts.map((d) => (
                  <option value={d.id} key={d.id}>
                    {platformSpecs.find((p) => p.id === d.platform)?.name} ·{" "}
                    {d.title} · v{d.version}
                  </option>
                ))}
              </select>
              <span className="tag">
                {draft.reviewed ? "已人工审阅" : "尚未审阅"}
              </span>
            </div>
            <div className="form-layout">
              <div>
                <Panel
                  title="内容包"
                  extra={<small>草稿 v{draft.version}</small>}
                >
                  <article className="content-preview">
                    <h2>{draft.title}</h2>
                    <div>{draft.body}</div>
                    <p>{draft.tags.join(" ")}</p>
                  </article>
                  <div className="row" style={{ marginTop: 14 }}>
                    <Button
                      disabled={!draft.reviewed || !ownReady || busy > 0}
                      onClick={() => void copyText()}
                    >
                      <Copy size={15} />
                      核验并复制文案
                    </Button>
                    <Button
                      disabled={!draft.reviewed || !ownReady || busy > 0}
                      onClick={async () => {
                        const result = await command<{ folder: string } | null>(
                          "publication.export",
                          {
                            draftId: draft.id,
                            bindingId: binding?.id ?? null,
                            includeLink,
                          },
                        );
                        if (result)
                          notify(
                            `内容包已导出：${result.folder}。发布状态仍由你人工确认。`,
                          );
                      }}
                    >
                      <Download size={15} />
                      导出内容包
                    </Button>
                    <Button quiet onClick={() => navigate("studio")}>
                      回到编辑
                    </Button>
                  </div>
                </Panel>
                <Panel title="资源获取方式">
                  <Notice warning>{spec?.rule}</Notice>
                  {spec?.linkMode !== "blocked" ? (
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={includeLink}
                        disabled={binding?.linkPermission !== "allowed"}
                        onChange={(e) => setIncludeLink(e.target.checked)}
                      />
                      附加已核验的本人分享链接与提取码
                    </label>
                  ) : (
                    <p className="muted">
                      此平台默认不附网盘URL、提取码或变体口令。
                    </p>
                  )}
                  {binding?.linkPermission !== "allowed" &&
                  spec?.linkMode !== "blocked" ? (
                    <small>
                      请先为具体发布账号记录允许链接的场景与依据，不能仅因编辑器支持输入网址就放行。
                    </small>
                  ) : null}
                  <div className="link-box">
                    {copy?.shareUrl ?? "本人分享尚未生成"}
                  </div>
                </Panel>
                {resource?.coverId ? (
                  <Panel title="资源封面">
                    <div className="publish-cover">
                      <Cover
                        id={resource.coverId}
                        title={resource.title}
                        large
                      />
                      <div>
                        <p>{draft.coverText || "没有单独生成封面文案"}</p>
                        <Button
                          onClick={() =>
                            void command(
                              "cover.export",
                              { id: resource.coverId },
                              "封面保存操作已完成。",
                            )
                          }
                        >
                          <Download size={14} />
                          另存封面
                        </Button>
                      </div>
                    </div>
                  </Panel>
                ) : null}
              </div>
              <div>
                <Panel
                  title="指纹窗口"
                  extra={<span className="tag">比特浏览器</span>}
                >
                  <Field label="发布账号与窗口">
                    <select
                      aria-label="发布账号窗口"
                      value={binding?.id ?? ""}
                      onChange={(e) => setBindingId(e.target.value)}
                    >
                      <option value="" disabled>
                        选择已绑定的窗口
                      </option>
                      {bindings.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.alias} · {b.windowId}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="property">
                    <span>资源保存与分享账号</span>
                    <span>{accountLabel(data!.accounts, copy!.accountId)}</span>
                  </div>
                  <div className="property">
                    <span>本人分享</span>
                    <span className={ownReady ? "good-text" : "danger-text"}>
                      {ownReady ? "已核验，分发时再次检查" : "尚未通过归属核验"}
                    </span>
                  </div>
                  <Field label="发布入口">
                    <input
                      value={binding?.editorUrl ?? ""}
                      readOnly
                      placeholder="先设置平台账号与窗口映射"
                    />
                  </Field>
                  <Notice>
                    只打开编辑器。请检查实际登录账号、上传素材，并由你点击发布。
                  </Notice>
                  <div className="row">
                    <Button
                      primary
                      disabled={
                        !binding || !draft.reviewed || !ownReady || busy > 0
                      }
                      onClick={() =>
                        void command(
                          "publication.open",
                          { draftId: draft.id, bindingId: binding.id },
                          "指定窗口与页面已打开，当前仍未记为已发布。",
                        )
                      }
                    >
                      <ExternalLink size={14} />
                      打开指定比特窗口
                    </Button>
                    <Button quiet onClick={() => navigate("settings")}>
                      <Settings2 size={14} />
                      设置映射
                    </Button>
                  </div>
                  {!ownReady ? (
                    <Notice warning>
                      请先完成转存、文件归属核验和本人分享。
                    </Notice>
                  ) : null}
                  {opened ? <Notice>编辑器已打开 · 尚未发布</Notice> : null}
                </Panel>
                <Panel title="发布记录" extra={<small>人工回填</small>}>
                  <Field label="发布后的内容链接">
                    <input
                      aria-label="发布内容链接"
                      type="url"
                      placeholder="https://…"
                      value={publishedUrl}
                      onChange={(e) => setPublishedUrl(e.target.value)}
                    />
                  </Field>
                  <div className="actions">
                    <Button
                      disabled={!opened || !publishedUrl || busy > 0}
                      onClick={() =>
                        void command(
                          "publication.mark",
                          {
                            draftId: draft.id,
                            bindingId: binding!.id,
                            url: publishedUrl,
                          },
                          "已保存人工发布记录。",
                        )
                      }
                    >
                      <Check size={14} />
                      人工标记已发布
                    </Button>
                  </div>
                  <div className="publication-history">
                    {data!.publications
                      .filter((p) => p.draftId === draft.id)
                      .map((p) => (
                        <div key={p.id}>
                          <strong>
                            {p.status === "opened"
                              ? "已打开编辑器"
                              : "人工确认已发布"}
                          </strong>
                          <small>
                            v{p.draftVersion} · {formatTime(p.createdAt)}
                          </small>
                          {p.url ? <span>{p.url}</span> : null}
                        </div>
                      ))}
                  </div>
                </Panel>
              </div>
            </div>
          </>
        ) : (
          <Empty
            title="此资源副本还没有草稿"
            action={
              <Button primary onClick={() => navigate("studio")}>
                去内容工作室
              </Button>
            }
          >
            先生成或手工写稿，保存并完成审阅后再准备发布。
          </Empty>
        )}
      </ResourceRequired>
    </>
  );
}
