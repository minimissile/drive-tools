import { IntakeOptionField } from "../resources/IntakeOptionField";
import { useIntakeShare } from "../resources/useIntakeShare";
import { chooseIntakeAccount } from "../resources/intake-share";
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
import { providerIds, providerSpecs } from "../../shared/providers";
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ImagePlus, Upload, X } from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
  useAppSelection,
} from "../state";
import { Button, Empty, Field, Header, Notice, Panel } from "../ui/primitives";
import { providerName } from "../resources/labels";
import { DriveBrowser } from "../drive-files/DriveBrowser";
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
    [manageOwn, setManageOwn] = useState(false),
    [parents, setParents] = useState<{ id: string; name: string }[]>([
      { id: "0", name: "分享根目录" },
    ]);
  const inspectionRevision = useRef(0);
  const account = data!.accounts.find((a) => a.id === accountId);
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
  const link = useIntakeShare({
    sourceText,
    code,
    provider,
    accountId,
    directory,
    accounts: data!.accounts,
    activeAccounts,
    onParsed: (result) => {
      draft.update({
        sourceText: result.share.url,
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
  const save = async (enqueue: boolean) => {
    if (isOwnResource && enqueue) return;
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
          tags: tags
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
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
                  : isOwnResource
                    ? "自有资源直接入库，保留已有分享链接，不转存、不创建目录。"
                    : selected.length
                      ? `已选 ${selected.length} / 100 项，可创建转存任务。`
                      : "资料可先保存为草稿；开始转存前请读取并选择文件。"}
              </>
            }
          >
            <Button
              primary={isOwnResource}
              disabled={
                submitting ||
                inspectionLoading ||
                imageDraft.loading ||
                busy > 0 ||
                !title.trim() ||
                !accountId ||
                !sourceText
              }
              onClick={() => void save(false)}
            >
              {submitting
                ? "正在保存…"
                : isOwnResource
                  ? "直接入库"
                  : `保存资料${!existing ? "草稿" : ""}`}
            </Button>
            {!isOwnResource && priorCopy?.status !== "ready" ? (
              <Button
                primary
                disabled={
                  submitting ||
                  inspectionLoading ||
                  imageDraft.loading ||
                  busy > 0 ||
                  !selected.length ||
                  !title ||
                  !accountId
                }
                onClick={() => void save(true)}
              >
                保存并开始转存 <ArrowDownToLine size={15} />
              </Button>
            ) : null}
          </ActionBar>
        ) : null
      }
    >
      <Header
        title={existing ? "继续整理这份资源。" : "录入一份资源。"}
        description={
          isOwnResource
            ? "录入自己的资源，直接保存到资源库；封面支持上传、拖放和直接粘贴。"
            : "先保存信息，再选择文件并转存；封面支持上传、拖放和直接粘贴。"
        }
      />
      {imageDraft.error ? <Notice danger>{imageDraft.error}</Notice> : null}
      {draft.error ? (
        <Notice danger>{draft.error}</Notice>
      ) : draft.restored ? (
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
          {!isOwnResource ? (
            <>
              <small>
                归档流程：填写资料 → 核验与转存 → 本人分享 →
                本地归档。下方先保存资料或读取文件。
              </small>
              <div className="stepper" aria-label="资源归档流程">
                {["资源信息", "校验与转存", "本人分享", "本地归档"].map(
                  (x, i) => (
                    <div key={x} className={i === 0 ? "active" : ""}>
                      <b>{i + 1}</b>
                      {x}
                    </div>
                  ),
                )}
              </div>
            </>
          ) : (
            <small>
              自有资源流程：填写资料 →
              直接入库。已有分享链接会保留，不进行转存或重新建链。
            </small>
          )}
          <div className="form-layout">
            <Panel title="基本信息">
              <div className="fields">
                <div className="intake-own-resource">
                  <div>
                    <label id="intake-own-label" htmlFor="intake-own-switch">
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
                <Field label="网盘分享链接" required hint="支持整段分享文案">
                  <textarea
                    aria-label="网盘分享链接"
                    aria-required="true"
                    value={sourceText}
                    disabled={!!existing}
                    placeholder="粘贴百度、夸克、UC、迅雷、光鸭或 PikPak 分享文案"
                    onBlur={() => void link.parse()}
                    onChange={(e) => {
                      link.invalidate();
                      inspectionRevision.current++;
                      draft.update({ sourceText: e.target.value, code: "" });
                      setParents([{ id: "0", name: "分享根目录" }]);
                      setInspection(null);
                      setInspectionLoading(false);
                      setInspectionError("");
                      setSelected([]);
                    }}
                  />
                </Field>
                <div className="row">
                  <span className="tag">{providerName(provider)}网盘</span>
                  <small>
                    {link.parsing
                      ? "正在识别链接与提取码…"
                      : isOwnResource
                        ? "离开输入框后自动识别链接，关联资源所属的本人账号。"
                        : "离开输入框后自动识别，并选择对应网盘的保存位置。"}
                  </small>
                </div>
                {link.error ? <Notice danger>{link.error}</Notice> : null}
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
                <div className="field-pair">
                  <Field as="div" label="分类" required>
                    <IntakeOptionField
                      kind="category"
                      label="分类"
                      value={category}
                      items={
                        options.data?.categories ?? defaultResourceCategories
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
                <Field label="标签" hint="可选，以逗号分隔">
                  <input
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="AI办公，提示词，入门"
                  />
                </Field>
                <Field label="资源说明" hint="用于AI提词与创作">
                  <textarea
                    className="tall"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    placeholder="资源包含什么、适合谁、有哪些可以明确介绍的内容？"
                  />
                </Field>
                <Button
                  disabled={busy > 0}
                  onClick={async () => {
                    const file = await command("resource.summaryFile");
                    if (file) {
                      if (file.text.length > 30000)
                        notify(
                          "说明文件超过30000字，请整理后再导入。",
                          "warning",
                        );
                      else {
                        setSummary(file.text);
                        notify(
                          `已载入 ${file.name}，保存资料后生效。`,
                          "success",
                        );
                      }
                    }
                  }}
                >
                  从本地TXT / Markdown载入说明
                </Button>
              </div>
            </Panel>
            <div>
              <Panel title="资源封面" extra={<small>可直接粘贴</small>}>
                <div
                  className="cover-drop"
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
                <div className="row" style={{ marginTop: 10 }}>
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
                <small>JPG / PNG / WebP · 最大8MB</small>
              </Panel>
              <Panel title={isOwnResource ? "资源归属" : "保存位置"}>
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
                    label={isOwnResource ? "资源所属账号" : "转存与分享账号"}
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
                        { value: "", label: "选择本人账号", disabled: true },
                        ...data!.accounts
                          .filter((a) => a.provider === provider && a.enabled)
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
                  <QueryError error={options.error} onRetry={options.reload} />
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
          {priorCopy?.status !== "ready" ? (
            <SourceContents
              inspection={inspection}
              provider={provider}
              selected={selected}
              parents={parents}
              loading={inspectionLoading}
              error={inspectionError}
              enabled={busy === 0 && !!accountId && !!sourceText}
              own={isOwnResource}
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
          ) : null}
          <Panel
            title={
              priorCopy?.folderId ? "管理已存入的资源" : "管理本人网盘资源"
            }
            extra={
              <Button quiet onClick={() => navigate("drive-files")}>
                打开独立网盘文件页
              </Button>
            }
          >
            <p>
              {priorCopy?.folderId
                ? "在本人副本中新增、删除、重命名文件，插入、替换或清理广告。内容变更后需要重新核验关联分享。"
                : isOwnResource
                  ? "直接浏览本人网盘，整理资源文件与已有广告，再保存资源资料。"
                  : "来源分享可浏览与选择。需要修改文件或广告时，先转存到本人网盘，再打开资源副本管理。"}
            </p>
            <Button
              disabled={!accountId || account?.status !== "connected"}
              onClick={() => setManageOwn((v) => !v)}
            >
              {manageOwn
                ? "收起文件管理"
                : priorCopy?.folderId
                  ? "展开资源目录管理"
                  : "展开本人网盘管理"}
            </Button>
          </Panel>
          {manageOwn && account?.status === "connected" ? (
            <DriveBrowser
              key={`${accountId}:${priorCopy?.id ?? "new"}`}
              accountId={accountId}
              copy={priorCopy}
              initialPath={priorCopy?.folderId ? priorCopy.directory : "/"}
              workspace={data!.dataPath}
            />
          ) : null}
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
