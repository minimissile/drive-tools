import { Select } from "../ui/Select";
import { ActionBar } from "../ui/ActionBar";
import { SearchSelect } from "../ui/SearchSelect";
import { useIpcQuery } from "../api/useIpcQuery";
import {
  channelProfiles,
  channelGroups,
  contentFormats,
  defaultContentFormat,
  type ContentFormat,
} from "../../shared/channels";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Eye, Pencil, Save, Sparkles } from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import {
  Button,
  Empty,
  Field,
  Header,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { ResourcePicker, ResourceRequired } from "../resources/components";
import { formatTime } from "../lib/format";
import { platformSpecs } from "../../shared/platforms";
import type { Draft, Platform } from "../../shared/types";
import CreativeSetup, { type CreativeConfig } from "../studio/CreativeSetup";
import CreativeEditor from "../studio/CreativeEditor";
import { useWorkingCopy } from "../studio/useWorkingCopy";
import "../studio/studio.css";

interface StudioContext {
  contentFormat?: ContentFormat;
  draftId: string;
  config: CreativeConfig;
  poolId: string;
  creationError?: string;
}
function readLocal<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Editor recovery also lives in SQLite. */
  }
}
function selection(copyId: string) {
  const value = readLocal<{ id: string; platform: Platform; copyId: string }>(
    "panxu-studio-selection-v1",
  );
  return value?.copyId === copyId ? value : null;
}
function configFor(draft?: Draft): CreativeConfig {
  const creative = draft?.creative;
  return {
    format: creative?.format ?? "text",
    templateId: creative?.templateId ?? "resource-guide",
    brief: creative?.brief ?? "",
    aspectRatio: creative?.aspectRatio ?? "3:4",
    pageCount: Math.max(1, creative?.cards.length || 3),
  };
}
export default function Studio() {
  const { copy } = useAppSelection();
  return (
    <>
      <Header
        title="一份资源，创作多种形式的内容。"
        description="选择模板，组织文案与画面，生成图片、图文组图和真实AI动态视频。"
      />
      <ResourceRequired>
        <ResourcePicker />
        {copy ? (
          <StudioResource key={copy.id} copyId={copy.id} />
        ) : (
          <Notice>请先为资源添加网盘副本。</Notice>
        )}
      </ResourceRequired>
    </>
  );
}
function StudioResource({ copyId }: { copyId: string }) {
  const [allChannels, setAllChannels] = useState(false);
  const [platform, setPlatform] = useState<Platform>(() => {
    const p =
      selection(copyId)?.platform ??
      readLocal<Platform>(`panxu-studio-platform-v1:${copyId}`);
    return platformSpecs.some((s) => s.id === p) ? p! : "xiaohongshu";
  });
  useEffect(() => {
    writeLocal(`panxu-studio-platform-v1:${copyId}`, platform);
  }, [copyId, platform]);
  const [channelQuery, setChannelQuery] = useState("");
  const [channelGroup, setChannelGroup] = useState("全部");
  const visiblePlatforms = platformSpecs.filter(
    (p) =>
      (channelGroup === "全部" ||
        channelProfiles[p.id].group === channelGroup) &&
      `${p.name} ${p.id} ${channelProfiles[p.id].purpose}`
        .toLowerCase()
        .includes(channelQuery.trim().toLowerCase()),
  );
  const shown = visiblePlatforms;
  return (
    <div className="studio-workspace">
      <div className="studio-channel-bar">
        <span>创作渠道</span>
        <SearchSelect
          label="创作渠道"
          value={{
            value: platform,
            label: platformSpecs.find((p) => p.id === platform)!.name,
          }}
          items={platformSpecs.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(id) => setPlatform(id as Platform)}
        />
        <Button
          quiet
          aria-expanded={allChannels}
          onClick={() => setAllChannels((v) => !v)}
        >
          {allChannels ? "收起渠道" : `浏览全部渠道（${platformSpecs.length}）`}
        </Button>
      </div>
      {allChannels ? (
        <nav className="platform-nav" aria-label="内容平台">
          <input
            aria-label="搜索分发渠道"
            placeholder="搜索渠道"
            value={channelQuery}
            onChange={(e) => setChannelQuery(e.target.value)}
          />
          <Select
            aria-label="渠道分类"
            value={channelGroup}
            onValueChange={(nextValue) => setChannelGroup(nextValue)}
            items={[
              ...channelGroups.map((group) => ({ value: group, label: group })),
            ]}
          />
          <small>{visiblePlatforms.length} 个匹配渠道</small>
          {shown.map((p) => (
            <button
              key={p.id}
              aria-label={p.name}
              aria-pressed={platform === p.id}
              onClick={() => setPlatform(p.id)}
            >
              <span className="platform-logo">{p.glyph}</span>
              {p.name}
            </button>
          ))}
          {!visiblePlatforms.length ? <small>没有匹配的渠道</small> : null}
        </nav>
      ) : null}
      <div>
        <StudioPlatform key={platform} platform={platform} copyId={copyId} />
      </div>
    </div>
  );
}
function StudioPlatform({
  platform,
  copyId,
}: {
  platform: Platform;
  copyId: string;
}) {
  const { data } = useAppData(),
    { resource } = useAppSelection(),
    { navigate, openSearch } = useAppNavigation(),
    { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const contextKey = `panxu-studio-context-v1:${copyId}:${platform}`;
  const [initial] = useState(() => readLocal<StudioContext>(contextKey));
  const [draftId, setDraftId] = useState(() => {
    const explicit = selection(copyId);
    return (
      (explicit?.platform === platform ? explicit.id : undefined) ??
      initial?.draftId ??
      ""
    );
  });
  const drafts = data!.drafts.filter(
    (d) => d.copyId === copyId && d.platform === platform,
  );
  const draft = drafts.find((d) => d.id === draftId) ?? drafts[0];
  const [contentFormat, setContentFormat] = useState<ContentFormat>(() => {
    const saved = initial?.contentFormat ?? draft?.contentFormat;
    return saved && channelProfiles[platform].formats.includes(saved)
      ? saved
      : defaultContentFormat(platform);
  });
  const [creating, setCreating] = useState(!draft);
  useEffect(() => {
    if (draft) setCreating(false);
  }, [draft?.id]);
  const [config, setConfig] = useState<CreativeConfig>(
    () => initial?.config ?? configFor(draft),
  );
  const [poolId, setPoolId] = useState(initial?.poolId ?? "");
  const [creationError, setCreationError] = useState(
    initial?.creationError ?? "",
  );
  const configLoaded = useRef(!!initial?.config || !!draft);
  useEffect(() => {
    if (!configLoaded.current && draft) {
      configLoaded.current = true;
      setConfig(configFor(draft));
    }
  }, [draft]);
  useEffect(() => {
    writeLocal(contextKey, {
      draftId: draft?.id ?? draftId,
      contentFormat,
      config,
      poolId,
      creationError,
    });
    writeLocal("panxu-studio-selection-v1", {
      id: draft?.id ?? draftId,
      platform,
      copyId,
      resourceId: resource?.id,
    });
    if (draft) {
      try {
        localStorage.setItem("panxu-publish-draft", draft.id);
      } catch {
        /* Explicit “准备发布” still carries the current draft. */
      }
    }
  }, [
    contextKey,
    contentFormat,
    draft?.id,
    draftId,
    config,
    poolId,
    platform,
    copyId,
    creationError,
  ]);
  const { data: searchContext } = useIpcQuery(
    "search.get",
    { id: draft?.topicId ?? "" },
    {
      enabled: !!draft?.topicId,
      revision: draft?.splitItemId,
      onError: (error) => notify(error.message, "error"),
    },
  );
  const spec = platformSpecs.find((p) => p.id === platform)!;
  const create = async (mode: "ai" | "blank" | "template") => {
    setCreationError("");
    try {
      const result = await command(
        "studio.create",
        {
          copyId,
          platform,
          contentFormat,
          poolId: poolId || null,
          sourceDraftId: mode === "ai" ? (draft?.id ?? null) : null,
          mode,
          ...config,
        },
        mode === "ai"
          ? "创意草稿已保存。请先核对方案，再生成实际图片或动态视频。"
          : undefined,
        true,
      );
      if (result) setDraftId(result.id);
    } catch (error) {
      setCreationError(
        error instanceof Error ? error.message : "创作失败，请重试。",
      );
    }
  };
  return (
    <Panel
      title={`${spec.name} · ${contentFormats[draft?.contentFormat ?? contentFormat].name}`}
      extra={
        <span className="tag">
          {data!.settings.aiModels.copy || "尚未选择模型"}
        </span>
      }
    >
      {draft?.topicId ? (
        <div className="search-target-label">
          搜索选题：{searchContext?.topic.keyword ?? draft.title} · 配套资料：
          {searchContext?.topic.targetPath ??
            (draft.splitItemId ? "本人拆分资料" : "整份资料")}
          <Button quiet onClick={() => openSearch({ topicId: draft.topicId! })}>
            查看选题与效果
          </Button>
        </div>
      ) : null}
      <details className="studio-channel-rules">
        <summary>渠道发布规则与内容建议</summary>
        <Notice warning={spec.linkMode !== "conditional"}>{spec.rule}</Notice>
        <p className="muted">
          {channelProfiles[platform].purpose}{" "}
          发布入口由账号后台核验，生成草稿不会自动发表。
        </p>
      </details>
      <details
        className="studio-creation"
        open={creating}
        onToggle={(e) => setCreating(e.currentTarget.open)}
      >
        <summary>
          {draft ? "创作下一份内容" : "选择形式与模板，开始创作"}
          <small>形式、模板与创作要求会按资源和平台保留</small>
        </summary>
        <Field
          label="平台内容形式"
          hint="与下方图片、组图或视频物料形式分别选择；选择形式后新建独立稿件"
        >
          <Select
            aria-label="平台内容形式"
            value={contentFormat}
            disabled={busy > 0}
            onValueChange={(nextValue) =>
              setContentFormat(nextValue as ContentFormat)
            }
            items={[
              ...channelProfiles[platform].formats.map((format) => ({
                value: format,
                label: (
                  <>
                    {contentFormats[format].name}
                    {format === "longform" ? " · 账号能力待核验" : ""}
                  </>
                ),
              })),
            ]}
          />
        </Field>
        {contentFormat === "longform" ? (
          <Notice warning>
            可先组织长文草稿；请在账号设置中核实实际长文发布入口，再打开对应窗口。
          </Notice>
        ) : null}
        <CreativeSetup
          value={config}
          onChange={(value) => {
            configLoaded.current = true;
            setConfig(value);
          }}
          disabled={busy > 0}
        />
        <div className="toolbar">
          <Select
            aria-label="选择词池"
            value={poolId}
            onValueChange={(nextValue) => setPoolId(nextValue)}
            items={[
              { value: "", label: "不使用词池，仅依据资源说明" },
              ...data!.pools
                .filter((p) => !p.resourceId || p.resourceId === resource?.id)
                .map((p) => ({
                  value: p.id,
                  label: (
                    <>
                      {p.name} · {p.keywords.length}词
                    </>
                  ),
                })),
            ]}
          />
          <Button
            primary
            disabled={busy > 0 || !data!.settings.openrouterConfigured}
            onClick={() => void create("ai")}
          >
            <Sparkles size={15} />
            生成AI草稿
          </Button>
          <Button disabled={busy > 0} onClick={() => void create("blank")}>
            <Pencil size={14} />
            新建手工草稿
          </Button>
          <Button disabled={busy > 0} onClick={() => void create("template")}>
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
      </details>
      {creationError ? (
        <Notice warning>
          上次创作未完成：{creationError} 原有内容和本次创作要求已保留。
          <Button quiet onClick={() => navigate("settings")}>
            调整模型配置
          </Button>
        </Notice>
      ) : null}
      {draft ? (
        <>
          <div className="row spread editor-bar">
            <Select
              aria-label="内容版本"
              value={draft.id}
              onValueChange={(nextValue) => setDraftId(nextValue)}
              items={[
                ...drafts.map((d) => ({
                  value: d.id,
                  label: (
                    <>
                      {contentFormats[d.contentFormat].name} ·{" "}
                      {d.title.slice(0, 25)} · v{d.version} ·{" "}
                      {formatTime(d.updatedAt)}
                    </>
                  ),
                })),
              ]}
            />
            <span className="tag">
              {draft.reviewed ? "已人工审阅" : "尚未审阅"}
            </span>
          </div>
          <DraftEditor key={draft.id} draft={draft} onSaved={setDraftId} />
        </>
      ) : (
        <Empty title={`为这份资源写一份${spec.format}`}>
          AI生成需要先接入OpenRouter；也可以直接新建手工草稿。两种方式都会保存在本地。
        </Empty>
      )}
    </Panel>
  );
}
function DraftEditor({
  draft,
  onSaved,
}: {
  draft: Draft;
  onSaved(id: string): void;
}) {
  const { openDraft } = useAppNavigation(),
    { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const working = useWorkingCopy(draft);
  const {
    value: { title, body, tags, coverText, creative },
    dirty,
  } = working;
  const [preview, setPreview] = useState(false);
  const [mediaReady, setMediaReady] = useState(
    !draft.creative || draft.creative.format === "text",
  );
  if (working.loading) return <LoadingState label="正在恢复编辑内容…" />;
  return (
    <>
      <div className="studio-working-status" role="status" aria-live="polite">
        <span>
          {working.error
            ? working.error
            : dirty
              ? `${working.restored ? "已恢复上次编辑 · " : ""}${working.saving ? "正在暂存…" : "编辑已暂存到本地"} · 尚未保存为新版本`
              : `当前为已保存版本 v${draft.version}`}
        </span>
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
          {coverText ? <footer>封面文案：{coverText}</footer> : null}
        </article>
      ) : (
        <div className="fields">
          <Field label="标题">
            <input
              aria-label="内容标题"
              value={title}
              maxLength={200}
              disabled={busy > 0}
              onChange={(e) => working.update({ title: e.target.value })}
            />
          </Field>
          <Field label="正文 / 脚本">
            <textarea
              aria-label="内容正文"
              className="content-textarea"
              value={body}
              maxLength={30000}
              disabled={busy > 0}
              onChange={(e) => working.update({ body: e.target.value })}
            />
          </Field>
          <div className="field-pair">
            <Field label="话题" hint="空格分隔">
              <input
                aria-label="内容话题"
                value={tags}
                maxLength={3000}
                disabled={busy > 0}
                onChange={(e) => working.update({ tags: e.target.value })}
              />
            </Field>
            <Field label="封面文案">
              <input
                aria-label="内容封面文案"
                value={coverText}
                maxLength={300}
                disabled={busy > 0}
                onChange={(e) => working.update({ coverText: e.target.value })}
              />
            </Field>
          </div>
        </div>
      )}
      {creative && creative.format !== "text" ? (
        <CreativeEditor
          key={draft.id}
          draft={draft}
          value={creative}
          onChange={(creative) => working.update({ creative })}
          dirty={dirty}
          onReady={setMediaReady}
        />
      ) : null}
      {dirty ? (
        <Notice warning>
          {working.error
            ? "暂存遇到问题，请先保存当前修改。"
            : "当前修改已独立暂存。"}
          点击“保存修改”会生成新版本，并要求重新审阅。
        </Notice>
      ) : null}
      <div className="row editor-review">
        <label className="checkbox">
          <input
            aria-label="已人工审阅"
            type="checkbox"
            checked={draft.reviewed && !dirty}
            disabled={dirty || busy > 0 || !mediaReady}
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
        不会把来源链接发给模型。图片与动态视频必须先生成实际文件；请核对素材与文案，平台要求的AI标识在发布后台填写。
      </small>
      <ActionBar
        label="稿件保存与发布"
        status={
          dirty
            ? "修改已暂存，保存为新版本后需要重新审阅。"
            : `已保存 v${draft.version} · ${draft.reviewed ? "已人工审阅" : "尚未审阅"}`
        }
      >
        <Button
          disabled={!dirty || busy > 0}
          onClick={async () => {
            const result = await command(
              "draft.save",
              {
                id: draft.id,
                title,
                body,
                tags: tags.split(/\s+/).filter(Boolean),
                coverText,
                ...(creative ? { creative } : {}),
              },
              "草稿版本已保存，请重新审阅。",
            );
            if (result) {
              try {
                await working.clear();
              } catch (e) {
                notify(
                  `版本已保存，但旧暂存清理失败：${(e as Error).message}`,
                  "warning",
                );
              }
              onSaved(result.id);
            }
          }}
        >
          <Save size={14} />
          保存修改
        </Button>
        {dirty ? (
          <Button
            quiet
            disabled={busy > 0 || working.saving}
            onClick={() => {
              if (
                window.confirm(
                  "放弃这份草稿尚未保存的修改，恢复当前已保存版本？",
                )
              )
                void working.reset().catch((e) => notify(e.message, "error"));
            }}
          >
            恢复已保存版本
          </Button>
        ) : null}
        <Button
          primary
          disabled={dirty || !draft.reviewed || busy > 0}
          onClick={() => openDraft(draft, "publish")}
        >
          准备发布 <ArrowRight size={15} />
        </Button>
      </ActionBar>
    </>
  );
}
