import { IntakeOptionField } from "../resources/IntakeOptionField";
import { useIntakeShare } from "../resources/useIntakeShare";
import { IntakeShareStatus } from "../resources/IntakeShareStatus";
import { chooseIntakeAccount } from "../resources/intake-share";
import {
  ResourceSimilarity,
  useResourceSimilarity,
} from "../resources/ResourceSimilarity";
import { useIpcQuery } from "../api/useIpcQuery";
import { QueryError } from "../ui/QueryError";
import { defaultResourceCategories } from "../../shared/intake";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { Workspace } from "../ui/Workspace";
import { ActionBar } from "../ui/ActionBar";
import { useAttachmentDraft } from "../hooks/useAttachmentDraft";
import { z } from "zod";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { ipc } from "../api/client";
import {
  formatResourceTagInput,
  parseResourceTagInput,
} from "../lib/resource-tag-input";
import { providerIds, providerSpecs } from "../../shared/providers";
import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ImagePlus,
  Upload,
  X,
} from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import { Button, Empty, Field, Header, Notice, Panel } from "../ui/primitives";
import { accountLabel, providerName } from "../resources/labels";
import { SourceContents, type ShareParent } from "../resources/SourceContents";
import type { Provider, RemoteFile, ShareInspection } from "../../shared/types";
export default function Intake() {
  const { data } = useAppData(),
    { activeAccounts, select, resource } = useAppSelection(),
    { editResourceId, editCopyId, navigate } = useAppNavigation(),
    { command, notify } = useAppActions(),
    { busy } = useAppActivity();
  const existing =
      data!.resources.find((r) => r.id === editResourceId) ??
      (resource?.id === editResourceId ? resource : undefined),
    priorCopy =
      editCopyId === "new"
        ? undefined
        : (existing?.copies.find((c) => c.id === editCopyId) ??
          existing?.copies[0]);
  const priorOwnResource =
    priorCopy?.status === "recorded" ||
    (!!priorCopy &&
      existing?.sourceKind === "owned" &&
      priorCopy.shareUrl === existing.sourceUrl);
  const chooseAccount = (p: Provider) =>
    chooseIntakeAccount(data!.accounts, activeAccounts, p);
  const draft = useLocalDraft(
    `panxu-intake-v1:${data!.dataPath}:${editResourceId ?? "new"}:${editCopyId ?? "new"}`,
    {
      provider: existing?.provider ?? "quark",
      accountId:
        priorCopy?.accountId ?? chooseAccount(existing?.provider ?? "quark"),
      sourceText: existing?.sourceUrl ?? "",
      code: "",
      title: existing?.title ?? "",
      category: existing?.category ?? "效率办公",
      tags: existing?.tags.join("，") ?? "",
      summary: existing?.summary ?? "",
      directory:
        priorCopy?.directory.slice(0, priorCopy.directory.lastIndexOf("/")) ??
        data!.accounts.find(
          (a) => a.id === chooseAccount(existing?.provider ?? "quark"),
        )?.defaultDirectory ??
        "/盘序资源",
      isOwnResource: priorOwnResource,
    },
    parseIntakeDraft,
  );
  const {
    provider,
    accountId,
    sourceText,
    code,
    title,
    category,
    tags,
    summary,
    directory,
    isOwnResource: draftOwnResource,
  } = draft.value;
  const intakeModeLocked = !!priorCopy && priorCopy.status !== "draft";
  const isOwnResource = intakeModeLocked ? priorOwnResource : draftOwnResource;
  const [step, setStep] = useState<"info" | "files">("info");
  const canTransfer = !isOwnResource && priorCopy?.status !== "ready";
  const currentStep = canTransfer ? step : "info";
  const stepRegion = useRef<HTMLDivElement>(null);
  const previousStep = useRef(currentStep);
  useEffect(() => {
    if (!canTransfer) setStep("info");
  }, [canTransfer]);
  useEffect(() => {
    if (previousStep.current === currentStep) return;
    previousStep.current = currentStep;
    stepRegion.current?.scrollIntoView({ block: "start" });
    stepRegion.current?.focus({ preventScroll: true });
  }, [currentStep]);
  const setProvider = (provider: Provider) => draft.update({ provider });
  const setAccountId = (accountId: string) => draft.update({ accountId });
  const setCode = (code: string) => draft.update({ code });
  const setTitle = (title: string) => draft.update({ title });
  const setCategory = (category: string) => draft.update({ category });
  const setTags = (tags: string) => draft.update({ tags });
  const setSummary = (summary: string) => draft.update({ summary });
  const setDirectory = (directory: string) => draft.update({ directory });
  const imageDraft = useAttachmentDraft(
    `panxu-intake-cover:${data!.dataPath}:${editResourceId ?? "new"}:${editCopyId ?? "new"}`,
  );
  const cover = imageDraft.value;
  const setCover = imageDraft.update;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [inspection, setInspection] = useState<ShareInspection | null>(null),
    [selected, setSelected] = useState<RemoteFile[]>([]),
    [inspectionLoading, setInspectionLoading] = useState(false),
    [inspectionError, setInspectionError] = useState(""),
    [parents, setParents] = useState<{ id: string; name: string }[]>([
      { id: "0", name: "分享根目录" },
    ]);
  const inspectionRevision = useRef(0);
  const account = data!.accounts.find((a) => a.id === accountId);
  const duplicateCopy = !priorCopy
    ? existing?.copies.find(
        (copy) =>
          (data!.accounts.find((item) => item.id === copy.accountId)
            ?.provider ?? existing.provider) === provider,
      )
    : undefined;
  const similarity = useResourceSimilarity({
    title,
    provider,
    excludeId: existing?.id,
    originalTitle: priorCopy ? existing?.title : undefined,
    invalidate: data?.resources,
  });
  const imageInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (existing?.coverId && cover === undefined && !imageDraft.loading)
      void ipc("cover.get", { id: existing.coverId })
        .then(imageDraft.restore)
        .catch(() => {});
  }, [existing?.coverId, imageDraft.loading]);
  const changeProvider = (value: Provider) => {
    setProvider(value);
    setAccountId(chooseAccount(value));
    setDirectory(
      data!.accounts.find((a) => a.id === chooseAccount(value))
        ?.defaultDirectory ?? "/盘序资源",
    );
    setInspection(null);
    setInspectionLoading(false);
    setInspectionError("");
    setSelected([]);
    setParents([{ id: "0", name: "分享根目录" }]);
  };
  const options = useIpcQuery("resource.intakeOptions", { accountId });
  const linkStatusId = useId();
  const link = useIntakeShare({
    sourceText,
    code,
    provider,
    accountId,
    directory,
    resourceId: existing?.id,
    accounts: data!.accounts,
    activeAccounts,
    onParsed: (result) => {
      draft.update({
        code: result.share.code,
        provider: result.provider,
        accountId: result.accountId,
        directory: result.directory,
      });
      if (result.provider !== provider || result.accountId !== accountId) {
        inspectionRevision.current++;
        setInspection(null);
        setInspectionLoading(false);
        setInspectionError("");
        setSelected([]);
        setParents([{ id: "0", name: "分享根目录" }]);
      }
    },
  });
  const inspect = async (
    parentId = "0",
    page = 1,
    cursor?: string,
    nextParents?: ShareParent[],
  ) => {
    const parsed = await link.parse();
    if (!parsed || !mounted.current) return;
    const requestRevision = ++inspectionRevision.current;
    setInspectionLoading(true);
    setInspectionError("");
    try {
      const result = await ipc("share.inspect", {
        accountId: parsed.accountId,
        sourceText: parsed.share.url,
        code: parsed.share.code,
        resourceId: existing?.id,
        parentId,
        page,
        cursor,
      });
      if (!mounted.current || requestRevision !== inspectionRevision.current)
        return;
      setInspection((previous) =>
        page > 1 && previous?.parentId === parentId
          ? {
              ...result,
              files: [
                ...new Map(
                  [...previous.files, ...result.files].map((f) => [f.id, f]),
                ).values(),
              ],
            }
          : result,
      );
      if (nextParents) setParents(nextParents);
      // Selection retains its full manifest while browsing another folder.
    } catch (error) {
      if (mounted.current && requestRevision === inspectionRevision.current)
        setInspectionError(
          error instanceof Error ? error.message : "读取分享失败，请重试。",
        );
    } finally {
      if (mounted.current && requestRevision === inspectionRevision.current)
        setInspectionLoading(false);
    }
  };
  const readImage = (file?: File) => {
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 8 * 1024 * 1024
    ) {
      notify("请选择8MB以内的PNG、JPEG或WebP图片。", "warning");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setCover(String(reader.result));
    reader.readAsDataURL(file);
  };
  const saveInFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const nextInFlight = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const formBlocked =
    submitting ||
    preparing ||
    !!duplicateCopy ||
    similarity.blocked ||
    inspectionLoading ||
    imageDraft.loading ||
    busy > 0 ||
    !title.trim() ||
    !accountId ||
    !sourceText.trim();
  const next = async () => {
    if (formBlocked || !canTransfer || nextInFlight.current) return;
    nextInFlight.current = true;
    setPreparing(true);
    try {
      // Moving steps only parses; the blur check never selects or transfers files.
      const parsed = await link.parse();
      if (parsed && mounted.current) setStep("files");
    } finally {
      nextInFlight.current = false;
      if (mounted.current) setPreparing(false);
    }
  };
  const save = async (enqueue: boolean) => {
    if (
      enqueue &&
      (!canTransfer || currentStep !== "files" || !selected.length)
    )
      return;
    if (formBlocked || nextInFlight.current) return;
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSubmitting(true);
    try {
      const parsed = await link.parse();
      if (!parsed || !mounted.current) return;
      const result = await command(
        "resource.save",
        {
          id: existing?.id,
          copyId: priorCopy?.id,
          title,
          sourceText: parsed.share.url,
          extractionCode: parsed.share.code || undefined,
          category,
          tags: parseResourceTagInput(tags),
          summary,
          coverData: cover,
          accountId: parsed.accountId,
          directory: isOwnResource
            ? (priorCopy?.directory ?? "/")
            : parsed.directory,
          isOwnResource,
          selectedFiles: !isOwnResource ? selected : undefined,
          enqueue,
        },
        isOwnResource
          ? "自有资源已直接入库，未创建转存任务。"
          : enqueue
            ? "转存任务已创建，目标账号已锁定。"
            : "资源信息已保存在本地。",
      );
      if (result) {
        draft.clear();
        imageDraft.clear();
        if (!mounted.current) return;
        select(result.resourceId, result.copyId);
        navigate(enqueue ? "tasks" : "library");
      }
    } finally {
      saveInFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };
  return (
    <Workspace
      onPaste={(e) => {
        if (currentStep !== "info") return;
        const image = [...e.clipboardData.items]
          .find((i) => i.kind === "file" && i.type.startsWith("image/"))
          ?.getAsFile();
        if (image) {
          e.preventDefault();
          readImage(image);
        }
      }}
      footer={
        data!.accounts.some((a) => a.enabled) ? (
          <ActionBar
            label="资源保存操作"
            status={
              <>
                {!title.trim() || !sourceText.trim() || !accountId
                  ? "保存前请填写资源标题、分享链接并选择账号。"
                  : duplicateCopy || similarity.duplicate
                    ? "此类网盘已有这份资源，请编辑已有记录。"
                    : similarity.loading
                      ? "正在检查名称相似的资源…"
                      : similarity.error
                        ? currentStep === "info"
                          ? "名称相似检查失败，请在标题下方重试后保存。"
                          : "名称相似检查失败，请重试读取后再提交。"
                        : isOwnResource
                          ? "自有资源直接入库，保留已有分享链接，不转存、不创建目录。"
                          : !canTransfer
                            ? "保存本次资料修改；网盘资源请在资源库中维护。"
                            : currentStep === "info"
                              ? "下一步选择需要转存的文件；也可先保存资料草稿。"
                              : selected.length
                                ? `已选 ${selected.length} / 100 项，可创建转存任务。`
                                : "请点击读取分享内容，选择需要转存的文件。"}
              </>
            }
          >
            {currentStep === "files" ? (
              <>
                <Button
                  disabled={submitting || preparing}
                  onClick={() => setStep("info")}
                >
                  <ArrowLeft size={15} />
                  上一步：资源信息
                </Button>
                <Button
                  primary
                  disabled={formBlocked || !selected.length}
                  onClick={() => void save(true)}
                >
                  {submitting ? "正在保存…" : "保存并开始转存"}
                  <ArrowDownToLine size={15} />
                </Button>
              </>
            ) : (
              <>
                <Button
                  primary={!canTransfer}
                  disabled={formBlocked}
                  onClick={() => void save(false)}
                >
                  {submitting
                    ? "正在保存…"
                    : isOwnResource
                      ? "直接入库"
                      : `保存资料${!existing ? "草稿" : ""}`}
                </Button>
                {canTransfer ? (
                  <Button
                    primary
                    disabled={formBlocked}
                    onClick={() => void next()}
                  >
                    {preparing ? "正在识别链接…" : "下一步：选择文件"}
                    <ArrowRight size={15} />
                  </Button>
                ) : null}
              </>
            )}
          </ActionBar>
        ) : null
      }
    >
      <Header
        title={existing ? "继续整理这份资源。" : "录入一份资源。"}
        description={
          currentStep === "files"
            ? "按需读取分享内容并选择转存文件；确认选择后再保存并创建转存任务。"
            : isOwnResource
              ? "录入自己的资源，直接保存到资源库；封面支持上传、拖放和直接粘贴。"
              : canTransfer
                ? "先填写资源资料，下一步再读取并选择文件；封面支持上传、拖放和直接粘贴。"
                : "编辑资源资料；文件、广告与分享链接在资源库中维护。"
        }
      />
      {imageDraft.error ? <Notice danger>{imageDraft.error}</Notice> : null}
      {draft.error ? (
        <Notice danger>{draft.error}</Notice>
      ) : draft.restored && currentStep === "info" ? (
        <Notice>
          已恢复本页未保存的输入。
          {isOwnResource
            ? "当前为自有资源模式，保存时直接入库。"
            : "开始转存前请重新读取并选择文件。"}
        </Notice>
      ) : null}
      {!data!.accounts.some((a) => a.enabled) ? (
        <Empty
          title="先添加一个本人网盘账号"
          action={
            <Button primary onClick={() => navigate("accounts")}>
              前往账号管理
            </Button>
          }
        >
          同一网盘可以添加多个账号，并为新任务选择不同的目标。
        </Empty>
      ) : (
        <>
          {canTransfer ? (
            <>
              <small>
                归档流程：填写资料 → 核验与转存 → 本人分享 → 本地归档。
                {currentStep === "info"
                  ? "当前填写资料，下一步选择文件。"
                  : "当前选择文件，提交后创建转存任务。"}
              </small>
              <div className="stepper" aria-label="资源归档流程">
                {["资源信息", "校验与转存", "本人分享", "本地归档"].map(
                  (x, i) => (
                    <div
                      key={x}
                      className={
                        i === (currentStep === "info" ? 0 : 1) ? "active" : ""
                      }
                      aria-current={
                        i === (currentStep === "info" ? 0 : 1)
                          ? "step"
                          : undefined
                      }
                    >
                      <b>{i + 1}</b>
                      {x}
                    </div>
                  ),
                )}
              </div>
            </>
          ) : isOwnResource ? (
            <small>
              自有资源流程：填写资料 →
              直接入库。已有分享链接会保留，不进行转存或重新建链。
            </small>
          ) : null}
          <div
            ref={stepRegion}
            tabIndex={-1}
            className="intake-step-region"
            aria-label={currentStep === "info" ? "资源信息" : "选择转存文件"}
          >
            {currentStep === "info" ? (
              <div className="form-layout intake-info-layout">
                <Panel title="基本信息" className="intake-info-panel">
                  <div className="fields intake-info-fields">
                    <div className="intake-own-resource">
                      <div>
                        <label
                          id="intake-own-label"
                          htmlFor="intake-own-switch"
                        >
                          自有资源
                        </label>
                        <p id="intake-own-description">
                          {isOwnResource
                            ? "已保存在自己的网盘，录入时跳过转存。"
                            : "开启后直接入库，适用于已经在自己网盘中的资源。"}
                        </p>
                      </div>
                      <Switch
                        id="intake-own-switch"
                        aria-labelledby="intake-own-label"
                        aria-describedby="intake-own-description"
                        checked={isOwnResource}
                        disabled={submitting || busy > 0 || intakeModeLocked}
                        onCheckedChange={(checked) => {
                          inspectionRevision.current++;
                          setInspection(null);
                          setInspectionLoading(false);
                          setInspectionError("");
                          setSelected([]);
                          setParents([{ id: "0", name: "分享根目录" }]);
                          draft.update({ isOwnResource: checked });
                        }}
                      />
                    </div>
                    <div className="intake-source-field">
                      <Field
                        label="网盘分享链接"
                        required
                        hint="支持整段分享文案"
                      >
                        <textarea
                          aria-label="网盘分享链接"
                          aria-required="true"
                          aria-describedby={linkStatusId}
                          aria-invalid={
                            !!link.error ||
                            link.validation?.status === "invalid" ||
                            undefined
                          }
                          value={sourceText}
                          disabled={!!existing}
                          placeholder="粘贴百度、夸克、UC、迅雷、光鸭或 PikPak 分享文案"
                          onBlur={() => void link.validate()}
                          onChange={(e) => {
                            link.invalidate();
                            inspectionRevision.current++;
                            draft.update({
                              sourceText: e.target.value,
                              code: "",
                            });
                            setParents([{ id: "0", name: "分享根目录" }]);
                            setInspection(null);
                            setInspectionLoading(false);
                            setInspectionError("");
                            setSelected([]);
                          }}
                        />
                      </Field>
                      <div className="intake-source-hint">
                        <span className="tag">
                          {providerName(provider)}网盘
                        </span>
                        <IntakeShareStatus
                          id={linkStatusId}
                          error={link.error}
                          parsing={link.parsing}
                          validation={link.validation}
                          hasValue={!!sourceText.trim()}
                          onRetry={() => void link.validate(true)}
                        />
                      </div>
                    </div>
                    <Field label="资源标题" required>
                      <input
                        aria-label="资源标题"
                        aria-required="true"
                        maxLength={200}
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="例如：自制AI办公练习清单"
                      />
                    </Field>
                    <ResourceSimilarity
                      check={similarity}
                      disabled={
                        submitting ||
                        imageDraft.loading ||
                        !!draft.error ||
                        !!imageDraft.error
                      }
                      onOpen={(id) => {
                        select(id);
                        navigate("library");
                      }}
                    />
                    <div className="field-pair">
                      <Field as="div" label="分类" required>
                        <IntakeOptionField
                          kind="category"
                          label="分类"
                          value={category}
                          items={
                            options.data?.categories ??
                            defaultResourceCategories
                          }
                          accountId={accountId}
                          onValueChange={setCategory}
                          onAdded={options.reload}
                        />
                      </Field>
                      <Field label="提取码" hint="如有">
                        <input
                          aria-label="提取码"
                          value={code}
                          maxLength={30}
                          onBlur={() => void link.validate()}
                          onChange={(e) => {
                            link.invalidate();
                            inspectionRevision.current++;
                            setCode(e.target.value);
                            setSelected([]);
                            setInspection(null);
                            setInspectionLoading(false);
                            setInspectionError("");
                          }}
                        />
                      </Field>
                    </div>
                    <Field
                      label="标签"
                      hint="支持 #标签 或逗号分隔，离开后自动整理"
                    >
                      <input
                        aria-label="资源标签"
                        value={tags}
                        onChange={(e) => setTags(e.target.value)}
                        onPaste={(e) => {
                          const text = e.clipboardData.getData("text/plain");
                          if (!/[\r\n\u2028\u2029]/u.test(text)) return;
                          // Single-line inputs discard newlines; retain tag boundaries before insertion.
                          e.preventDefault();
                          e.stopPropagation();
                          const input = e.currentTarget;
                          const start =
                            input.selectionStart ?? input.value.length;
                          const end = input.selectionEnd ?? start;
                          const pasted = text.replace(
                            /[\r\n\u2028\u2029]+/gu,
                            "，",
                          );
                          setTags(
                            input.value.slice(0, start) +
                              pasted +
                              input.value.slice(end),
                          );
                          requestAnimationFrame(() => {
                            if (document.activeElement === input)
                              input.setSelectionRange(
                                start + pasted.length,
                                start + pasted.length,
                              );
                          });
                        }}
                        onBlur={(e) =>
                          setTags(formatResourceTagInput(e.target.value))
                        }
                        placeholder="#AI办公 #提示词 #入门"
                      />
                    </Field>
                    <div className="intake-summary-field">
                      <Field label="资源说明" hint="用于AI提词与创作">
                        <textarea
                          className="tall"
                          value={summary}
                          onChange={(e) => setSummary(e.target.value)}
                          placeholder="资源包含什么、适合谁、有哪些可以明确介绍的内容？"
                        />
                      </Field>
                    </div>
                  </div>
                </Panel>
                <div className="intake-info-side">
                  <Panel
                    title="资源封面"
                    className="intake-cover-panel"
                    extra={<small>支持粘贴与拖放</small>}
                  >
                    <div
                      className="cover-drop intake-cover-preview"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        readImage(e.dataTransfer.files[0]);
                      }}
                    >
                      {cover ? (
                        <img src={cover} alt="待保存封面" />
                      ) : (
                        <>
                          <ImagePlus size={26} />
                          <strong>粘贴或拖入封面</strong>
                          <small>在当前表单按 ⌘V / Ctrl+V</small>
                        </>
                      )}
                    </div>
                    <div className="intake-cover-actions">
                      <Button onClick={() => imageInput.current?.click()}>
                        <Upload size={14} />
                        选择图片
                      </Button>
                      {cover ? (
                        <Button quiet onClick={() => setCover(null)}>
                          <X size={14} />
                          移除
                        </Button>
                      ) : null}
                    </div>
                    <input
                      ref={imageInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      hidden
                      onChange={(e) => readImage(e.target.files?.[0])}
                    />
                    <small className="intake-cover-note">
                      JPG / PNG / WebP ·
                      原图最大8MB，保存时自动转为200KB以内的WebP。
                    </small>
                  </Panel>
                  <Panel
                    title={isOwnResource ? "资源归属" : "保存位置"}
                    className="intake-location-panel"
                  >
                    {duplicateCopy && existing ? (
                      <Notice warning>
                        此资源已存入{providerName(provider)}
                        网盘，同类型网盘只保留一份。
                        <Button
                          size="compact"
                          disabled={
                            submitting ||
                            imageDraft.loading ||
                            !!draft.error ||
                            !!imageDraft.error
                          }
                          onClick={() => {
                            select(existing.id, duplicateCopy.id);
                            navigate("library");
                          }}
                        >
                          查看已有记录
                        </Button>
                      </Notice>
                    ) : null}
                    <div className="fields">
                      <Field label="网盘类型">
                        <Select
                          value={provider}
                          disabled={!!priorCopy}
                          onValueChange={(nextValue) => {
                            link.invalidate();
                            inspectionRevision.current++;
                            changeProvider(nextValue as Provider);
                          }}
                          items={[
                            ...providerIds.map((id) => ({
                              value: id,
                              label: <>{providerSpecs[id].name}网盘</>,
                            })),
                          ]}
                        />
                      </Field>
                      <Field
                        label={
                          isOwnResource ? "资源所属账号" : "转存与分享账号"
                        }
                      >
                        <Select
                          aria-label={
                            isOwnResource ? "资源所属账号" : "转存与分享账号"
                          }
                          value={accountId}
                          disabled={!!priorCopy}
                          onValueChange={(nextValue) => {
                            link.invalidate();
                            inspectionRevision.current++;
                            setAccountId(nextValue);
                            setDirectory(
                              data!.accounts.find((a) => a.id === nextValue)
                                ?.defaultDirectory ?? "/盘序资源",
                            );
                            setInspection(null);
                            setInspectionLoading(false);
                            setInspectionError("");
                            setSelected([]);
                          }}
                          items={[
                            {
                              value: "",
                              label: "选择本人账号",
                              disabled: true,
                            },
                            ...data!.accounts
                              .filter(
                                (a) => a.provider === provider && a.enabled,
                              )
                              .map((a) => ({
                                value: a.id,
                                label: (
                                  <>
                                    {a.alias}
                                    {a.status !== "connected"
                                      ? isOwnResource
                                        ? " · 待核验"
                                        : " · 需登录"
                                      : ""}
                                    {a.isDefault ? " · 默认" : ""}
                                  </>
                                ),
                              })),
                          ]}
                        />
                      </Field>
                      {!isOwnResource ? (
                        <Field
                          as="div"
                          label="目标目录"
                          hint="可新增选项，转存时创建资源专用子目录"
                        >
                          <IntakeOptionField
                            key={accountId}
                            kind="directory"
                            label="目标目录"
                            value={directory}
                            disabled={!!priorCopy}
                            accountId={accountId}
                            items={
                              options.data?.directories ?? [
                                account?.defaultDirectory ?? "/盘序资源",
                              ]
                            }
                            onValueChange={setDirectory}
                            onAdded={options.reload}
                          />
                        </Field>
                      ) : null}
                      <QueryError
                        error={options.error}
                        onRetry={options.reload}
                      />
                    </div>
                    <small>
                      {isOwnResource
                        ? "选择保存这份资源的本人账号。直接入库无需读取文件或转存，分享归属可在资源库中手动核验。"
                        : "转存和创建分享都使用此账号。已有副本不能通过编辑资料改绑。"}
                    </small>
                    {!isOwnResource && account?.status !== "connected" ? (
                      <div className="row" style={{ marginTop: 10 }}>
                        <Button
                          disabled={!accountId || busy > 0}
                          onClick={() =>
                            void command("account.login", { id: accountId })
                          }
                        >
                          登录账号
                        </Button>
                        <Button
                          quiet
                          disabled={!accountId || busy > 0}
                          onClick={() =>
                            void command(
                              "account.check",
                              { id: accountId },
                              "账号UID已核验。",
                            )
                          }
                        >
                          核验登录
                        </Button>
                      </div>
                    ) : null}
                  </Panel>
                </div>
              </div>
            ) : (
              <>
                <dl className="intake-transfer-summary" aria-label="待转存资源">
                  <div>
                    <dt>资源名称</dt>
                    <dd>{title}</dd>
                  </div>
                  <div>
                    <dt>目标账号</dt>
                    <dd>{accountLabel(data!.accounts, accountId)}</dd>
                  </div>
                  <div>
                    <dt>保存目录</dt>
                    <dd>{directory}</dd>
                  </div>
                </dl>
                {link.error ? <Notice danger>{link.error}</Notice> : null}
                <QueryError
                  error={similarity.error}
                  loading={similarity.loading}
                  onRetry={similarity.reload}
                  title="名称相似检查失败"
                />
                {duplicateCopy || similarity.duplicate ? (
                  <Notice warning>
                    此类网盘已有这份资源，请返回资源信息查看已有记录。
                  </Notice>
                ) : null}
                <SourceContents
                  inspection={inspection}
                  provider={provider}
                  selected={selected}
                  parents={parents}
                  loading={inspectionLoading}
                  error={inspectionError}
                  enabled={busy === 0 && !!accountId && !!sourceText}
                  own={false}
                  onRead={(parentId, page, cursor, next) =>
                    void inspect(parentId, page, cursor, next)
                  }
                  onOpenOfficial={() =>
                    void command("share.open", {
                      accountId,
                      sourceText,
                      code,
                      resourceId: existing?.id,
                    })
                  }
                  onSelect={setSelected}
                />
              </>
            )}
          </div>
        </>
      )}
    </Workspace>
  );
}

const parseIntakeDraft = (value: unknown) =>
  z
    .object({
      provider: z.enum(providerIds),
      accountId: z.string(),
      sourceText: z.string(),
      code: z.string(),
      title: z.string(),
      category: z.string(),
      tags: z.string(),
      summary: z.string(),
      directory: z.string(),
      isOwnResource: z.boolean().default(false),
    })
    .parse(value);
