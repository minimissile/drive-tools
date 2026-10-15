import { useEffect, useState } from "react";
import { ArrowRight, Eye, Pencil, Save, Sparkles } from "lucide-react";
import { useApp } from "../state";
import {
  Button,
  Empty,
  Field,
  Header,
  Notice,
  Panel,
  ResourcePicker,
  ResourceRequired,
  formatTime,
} from "../components";
import { platformSpecs } from "../../shared/platforms";
import type { Draft, Platform } from "../../shared/types";
export default function Studio() {
  const { data, resource, copy, command, navigate, busy, notify } = useApp();
  const [platform, setPlatform] = useState<Platform>("xiaohongshu"),
    [poolId, setPoolId] = useState(""),
    [draftId, setDraftId] = useState(""),
    [preview, setPreview] = useState(false);
  const drafts = data!.drafts.filter(
      (d) => d.copyId === copy?.id && d.platform === platform,
    ),
    draft = drafts.find((d) => d.id === draftId) ?? drafts[0];
  const [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [tags, setTags] = useState(""),
    [coverText, setCoverText] = useState("");
  useEffect(() => {
    setTitle(draft?.title ?? "");
    setBody(draft?.body ?? "");
    setTags(draft?.tags.join(" ") ?? "");
    setCoverText(draft?.coverText ?? "");
  }, [draft?.id, draft?.updatedAt]);
  const dirty =
    !!draft &&
    (title !== draft.title ||
      body !== draft.body ||
      tags !== draft.tags.join(" ") ||
      coverText !== draft.coverText);
  const spec = platformSpecs.find((p) => p.id === platform)!;
  const generate = async () => {
    const result = await command<Draft>(
      "draft.generate",
      { copyId: copy!.id, platform, poolId: poolId || null },
      "AI草稿已保存。请核对事实与渠道规则后再使用。",
    );
    if (result) setDraftId(result.id);
  };
  const manual = async (template = false) => {
    const result = await command<Draft>("draft.manual", {
      copyId: copy!.id,
      platform,
      template,
    });
    if (result) setDraftId(result.id);
  };
  return (
    <>
      <Header
        title="一份资源，写成不同平台的内容。"
        description="围绕词池组织表达，保留平台差异、内容版本和人工审阅。"
      />
      <ResourceRequired>
        <ResourcePicker />
        <div className="studio-layout">
          <nav className="platform-nav" aria-label="内容平台">
            {platformSpecs.map((p) => (
              <button
                key={p.id}
                aria-label={p.name}
                aria-pressed={platform === p.id}
                onClick={() => {
                  setPlatform(p.id);
                  setDraftId("");
                }}
              >
                <span className="platform-logo">{p.glyph}</span>
                {p.name}
              </button>
            ))}
          </nav>
          <div>
            <Panel
              title={`${spec.name} · ${spec.format}`}
              extra={
                <span className="tag">
                  {data!.settings.model || "尚未选择模型"}
                </span>
              }
            >
              <Notice warning={spec.linkMode !== "conditional"}>
                {spec.rule}
              </Notice>
              <div className="toolbar">
                <select
                  aria-label="选择词池"
                  value={poolId}
                  onChange={(e) => setPoolId(e.target.value)}
                >
                  <option value="">不使用词池，仅依据资源说明</option>
                  {data!.pools
                    .filter(
                      (p) => !p.resourceId || p.resourceId === resource?.id,
                    )
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.keywords.length}词
                      </option>
                    ))}
                </select>
                <Button
                  primary
                  disabled={
                    !copy || busy > 0 || !data!.settings.openrouterConfigured
                  }
                  onClick={() => void generate()}
                >
                  <Sparkles size={15} />
                  生成AI草稿
                </Button>
                <Button
                  disabled={!copy || busy > 0}
                  onClick={() => void manual()}
                >
                  <Pencil size={14} />
                  新建手工草稿
                </Button>
                <Button
                  disabled={!copy || busy > 0}
                  onClick={() => void manual(true)}
                >
                  使用本地平台模板
                </Button>
              </div>
              {!data!.settings.openrouterConfigured ? (
                <Notice>
                  尚未配置OpenRouter。可以先手工写稿，或到设置中接入AI。
                  <Button quiet onClick={() => navigate("settings")}>
                    连接OpenRouter
                  </Button>
                </Notice>
              ) : null}
              {draft ? (
                <>
                  <div className="row spread editor-bar">
                    <select
                      aria-label="内容版本"
                      value={draft.id}
                      onChange={(e) => setDraftId(e.target.value)}
                    >
                      {drafts.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.title.slice(0, 25)} · v{d.version} ·{" "}
                          {formatTime(d.updatedAt)}
                        </option>
                      ))}
                    </select>
                    <Button quiet onClick={() => setPreview((v) => !v)}>
                      <Eye size={14} />
                      {preview ? "编辑" : "预览"}
                    </Button>
                  </div>
                  {preview ? (
                    <article className="content-preview">
                      <h2>{title}</h2>
                      <div>{body}</div>
                      <p>{tags}</p>
                      {coverText ? (
                        <footer>封面文案：{coverText}</footer>
                      ) : null}
                    </article>
                  ) : (
                    <div className="fields">
                      <Field label="标题">
                        <input
                          aria-label="内容标题"
                          value={title}
                          maxLength={200}
                          onChange={(e) => setTitle(e.target.value)}
                        />
                      </Field>
                      <Field label="正文 / 脚本">
                        <textarea
                          aria-label="内容正文"
                          className="content-textarea"
                          value={body}
                          maxLength={30000}
                          onChange={(e) => setBody(e.target.value)}
                        />
                      </Field>
                      <div className="field-pair">
                        <Field label="话题" hint="空格分隔">
                          <input
                            value={tags}
                            onChange={(e) => setTags(e.target.value)}
                          />
                        </Field>
                        <Field label="封面文案">
                          <input
                            value={coverText}
                            maxLength={300}
                            onChange={(e) => setCoverText(e.target.value)}
                          />
                        </Field>
                      </div>
                    </div>
                  )}
                  {dirty ? (
                    <Notice warning>
                      当前有未保存修改。保存后会生成新版本，并要求重新审阅。
                    </Notice>
                  ) : null}
                  <div className="row editor-review">
                    <label className="checkbox">
                      <input
                        aria-label="已人工审阅"
                        type="checkbox"
                        checked={draft.reviewed && !dirty}
                        disabled={dirty || busy > 0}
                        onChange={(e) =>
                          void command("draft.review", {
                            id: draft.id,
                            reviewed: e.target.checked,
                          })
                        }
                      />
                      已核对资源事实、表达和渠道获取方式
                    </label>
                  </div>
                  <small>
                    不会把来源链接发给模型。平台要求的AI内容标识请在发布后台填写。
                  </small>
                  <div className="actions">
                    <Button
                      disabled={!dirty || busy > 0}
                      onClick={async () => {
                        const result = await command<Draft>(
                          "draft.save",
                          {
                            id: draft.id,
                            title,
                            body,
                            tags: tags.split(/\s+/).filter(Boolean),
                            coverText,
                          },
                          "草稿版本已保存，请重新审阅。",
                        );
                        if (result) setDraftId(result.id);
                      }}
                    >
                      <Save size={14} />
                      保存修改
                    </Button>
                    <Button
                      primary
                      disabled={dirty || !draft.reviewed}
                      onClick={() => {
                        localStorage.setItem("panxu-publish-draft", draft.id);
                        navigate("publish");
                      }}
                    >
                      准备发布 <ArrowRight size={15} />
                    </Button>
                  </div>
                </>
              ) : (
                <Empty title={`为这份资源写一份${spec.format}`}>
                  AI生成需要先接入OpenRouter；也可以直接新建手工草稿。两种方式都会保存在本地。
                </Empty>
              )}
            </Panel>
          </div>
        </div>
      </ResourceRequired>
    </>
  );
}
