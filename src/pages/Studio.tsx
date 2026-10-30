import { windowStorage } from "../storage/window-storage";
import { Select } from "../ui/Select";
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
import { ArrowRight, Pencil, Sparkles } from "lucide-react";
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
import DraftEditor from "../studio/DraftEditor";
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
    return JSON.parse(windowStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: unknown) {
  try {
    windowStorage.setItem(key, JSON.stringify(value));
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
export default function Studio({
  initialPlatform,
}: {
  initialPlatform?: Platform;
}) {
  const { copy } = useAppSelection();
  return (
    <>
      <Header
        title={
          initialPlatform === "csdn"
            ? "CSDN 教程创作"
            : "一份资源，创作多种形式的内容。"
        }
        description={
          initialPlatform === "csdn"
            ? "选择本人资料，补充教程依据，编辑并审阅技术文章。"
            : "选择模板，组织文案与画面，生成图片、图文组图和真实AI动态视频。"
        }
      />
      <ResourceRequired>
        <ResourcePicker />
        {copy ? (
          <StudioResource
            key={copy.id}
            copyId={copy.id}
            initialPlatform={initialPlatform}
          />
        ) : (
          <Notice>请先为资源添加网盘副本。</Notice>
        )}
      </ResourceRequired>
    </>
  );
}
function StudioResource({
  copyId,
  initialPlatform,
}: {
  copyId: string;
  initialPlatform?: Platform;
}) {
  const { navigate } = useAppNavigation();
  const [allChannels, setAllChannels] = useState(false);
  const [platform, setPlatform] = useState<Platform>(() => {
    const p =
      initialPlatform ??
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
        {initialPlatform ? (
          <>
            <strong>
              {platformSpecs.find((p) => p.id === initialPlatform)!.name}
            </strong>
            <Button quiet onClick={() => navigate("studio")}>
              其他渠道创作
            </Button>
          </>
        ) : (
          <>
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
              {allChannels
                ? "收起渠道"
                : `浏览全部渠道（${platformSpecs.length}）`}
            </Button>
          </>
        )}
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
        windowStorage.setItem("panxu-publish-draft", draft.id);
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
