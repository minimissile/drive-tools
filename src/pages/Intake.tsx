import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUp,
  File as FileIcon,
  Folder,
  ImagePlus,
  Upload,
  X,
} from "lucide-react";
import { useApp } from "../state";
import {
  Button,
  Empty,
  Field,
  Header,
  Notice,
  Panel,
  formatSize,
  providerName,
} from "../components";
import type {
  Provider,
  RemoteFile,
  ShareInput,
  ShareInspection,
} from "../../shared/types";
export default function Intake() {
  const {
    data,
    command,
    activeAccounts,
    editResourceId,
    editCopyId,
    navigate,
    select,
    busy,
    notify,
    resource,
  } = useApp();
  const existing =
      data!.resources.find((r) => r.id === editResourceId) ??
      (resource?.id === editResourceId ? resource : undefined),
    priorCopy =
      editCopyId === "new"
        ? undefined
        : (existing?.copies.find((c) => c.id === editCopyId) ??
          existing?.copies[0]);
  const chooseAccount = (p: Provider) =>
    data!.accounts.find(
      (a) => a.id === activeAccounts[p] && a.provider === p && a.enabled,
    )?.id ??
    data!.accounts.find((a) => a.provider === p && a.enabled && a.isDefault)
      ?.id ??
    data!.accounts.find((a) => a.provider === p && a.enabled)?.id ??
    "";
  const [provider, setProvider] = useState<Provider>(
      existing?.provider ?? "quark",
    ),
    [accountId, setAccountId] = useState(
      priorCopy?.accountId ?? chooseAccount(existing?.provider ?? "quark"),
    ),
    [sourceText, setSourceText] = useState(existing?.sourceUrl ?? ""),
    [code, setCode] = useState(""),
    [title, setTitle] = useState(existing?.title ?? ""),
    [category, setCategory] = useState(existing?.category ?? "效率办公"),
    [tags, setTags] = useState(existing?.tags.join("，") ?? ""),
    [summary, setSummary] = useState(existing?.summary ?? ""),
    [directory, setDirectory] = useState(
      priorCopy?.directory.slice(0, priorCopy.directory.lastIndexOf("/")) ??
        "/盘序资源",
    ),
    [rightsConfirmed, setRights] = useState(false),
    [cover, setCover] = useState<string | null | undefined>(undefined),
    [inspection, setInspection] = useState<ShareInspection | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [parents, setParents] = useState<{ id: string; name: string }[]>([
      { id: "0", name: "分享根目录" },
    ]);
  const account = data!.accounts.find((a) => a.id === accountId);
  const imageInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (existing?.coverId)
      void window.panxu
        .invoke<string>("cover.get", { id: existing.coverId })
        .then(setCover)
        .catch(() => {});
  }, [existing?.coverId]);
  const changeProvider = (value: Provider) => {
    setProvider(value);
    setAccountId(chooseAccount(value));
    setDirectory(
      data!.accounts.find((a) => a.id === chooseAccount(value))
        ?.defaultDirectory ?? "/盘序资源",
    );
    setInspection(null);
    setSelected([]);
    setParents([{ id: "0", name: "分享根目录" }]);
  };
  const parse = async () => {
    const result = await command<ShareInput>("share.parse", {
      text: sourceText,
      code,
    });
    if (!result) return;
    setSourceText(result.url);
    setCode(result.code);
    if (result.provider !== provider) changeProvider(result.provider);
    return result;
  };
  const inspect = async (parentId = "0", page = 1) => {
    const parsed = await parse();
    if (!parsed) return;
    const targetAccount =
      parsed.provider === provider
        ? accountId
        : (activeAccounts[parsed.provider] ??
          data!.accounts.find(
            (a) => a.provider === parsed.provider && a.enabled && a.isDefault,
          )?.id ??
          "");
    const result = await command<ShareInspection>("share.inspect", {
      accountId: targetAccount,
      sourceText: parsed.url,
      code: parsed.code,
      resourceId: existing?.id,
      parentId,
      page,
    });
    if (result) {
      setInspection(
        page > 1 && inspection?.parentId === parentId
          ? { ...result, files: [...inspection.files, ...result.files] }
          : result,
      );
      if (page === 1) setSelected([]);
    }
  };
  const readImage = (file?: File) => {
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 8 * 1024 * 1024
    ) {
      notify("请选择8MB以内的PNG、JPEG或WebP图片。", true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setCover(String(reader.result));
    reader.readAsDataURL(file);
  };
  const save = async (enqueue: boolean) => {
    const result = await command<{
      resourceId: string;
      copyId: string;
      jobId: string | null;
    }>(
      "resource.save",
      {
        id: existing?.id,
        copyId: priorCopy?.id,
        title,
        sourceText,
        extractionCode: code || undefined,
        category,
        tags: tags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
        summary,
        coverData: cover,
        accountId,
        directory,
        rightsConfirmed,
        selectedFiles: inspection?.files.filter((f) => selected.includes(f.id)),
        enqueue,
      },
      enqueue ? "转存任务已创建，目标账号已锁定。" : "资源信息已保存在本地。",
    );
    if (result) {
      select(result.resourceId, result.copyId);
      navigate(enqueue ? "tasks" : "library");
    }
  };
  return (
    <div
      onPaste={(e) => {
        const image = [...e.clipboardData.items]
          .find((i) => i.kind === "file" && i.type.startsWith("image/"))
          ?.getAsFile();
        if (image) {
          e.preventDefault();
          readImage(image);
        }
      }}
    >
      <Header
        title={existing ? "继续整理这份资源。" : "录入一份资源。"}
        description="先保存信息，再选择文件并转存；封面支持上传、拖放和直接粘贴。"
      />
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
          <div className="stepper">
            {["资源信息", "校验与转存", "本人分享", "本地归档"].map((x, i) => (
              <div key={x} className={i === 0 ? "active" : ""}>
                <b>{i + 1}</b>
                {x}
              </div>
            ))}
          </div>
          <div className="form-layout">
            <Panel title="基本信息">
              <div className="fields">
                <Field label="网盘分享链接" required hint="支持整段分享文案">
                  <textarea
                    aria-label="网盘分享链接"
                    value={sourceText}
                    disabled={!!existing}
                    placeholder="粘贴百度或夸克网盘链接，也可以粘贴带提取码的整段文案"
                    onChange={(e) => {
                      setSourceText(e.target.value);
                      setInspection(null);
                      setSelected([]);
                    }}
                  />
                </Field>
                <div className="row">
                  <span className="tag">{providerName(provider)}网盘</span>
                  <Button
                    quiet
                    disabled={!sourceText || busy > 0}
                    onClick={() => void parse()}
                  >
                    解析链接与提取码
                  </Button>
                </div>
                <Field label="资源标题" required>
                  <input
                    aria-label="资源标题"
                    maxLength={200}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="例如：自制AI办公练习清单"
                  />
                </Field>
                <div className="field-pair">
                  <Field label="分类" required>
                    <input
                      list="category-options"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                    />
                    <datalist id="category-options">
                      {[
                        "效率办公",
                        "技能学习",
                        "学习资料",
                        "设计素材",
                        "技术开发",
                        "其他",
                      ].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </datalist>
                  </Field>
                  <Field label="提取码" hint="如有">
                    <input
                      aria-label="提取码"
                      value={code}
                      maxLength={30}
                      onChange={(e) => {
                        setCode(e.target.value);
                        setInspection(null);
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
                    const file = await command<{
                      name: string;
                      text: string;
                    } | null>("resource.summaryFile");
                    if (file) {
                      if (file.text.length > 30000)
                        notify("说明文件超过30000字，请整理后再导入。", true);
                      else {
                        setSummary(file.text);
                        notify(`已载入 ${file.name}，保存资料后生效。`);
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
              <Panel title="保存位置">
                <div className="fields">
                  <Field label="网盘类型">
                    <select
                      value={provider}
                      disabled={!!priorCopy}
                      onChange={(e) =>
                        changeProvider(e.target.value as Provider)
                      }
                    >
                      <option value="quark">夸克</option>
                      <option value="baidu">百度</option>
                    </select>
                  </Field>
                  <Field label="转存与分享账号">
                    <select
                      aria-label="转存与分享账号"
                      value={accountId}
                      disabled={!!priorCopy}
                      onChange={(e) => {
                        setAccountId(e.target.value);
                        setDirectory(
                          data!.accounts.find((a) => a.id === e.target.value)
                            ?.defaultDirectory ?? "/盘序资源",
                        );
                        setInspection(null);
                        setSelected([]);
                      }}
                    >
                      <option value="" disabled>
                        选择本人账号
                      </option>
                      {data!.accounts
                        .filter((a) => a.provider === provider && a.enabled)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.alias}
                            {a.status !== "connected" ? " · 需登录" : ""}
                            {a.isDefault ? " · 默认" : ""}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="目标目录" hint="自动创建资源专用子目录">
                    <input
                      value={directory}
                      disabled={!!priorCopy}
                      onChange={(e) => setDirectory(e.target.value)}
                    />
                  </Field>
                </div>
                <small>
                  转存和创建分享都使用此账号。已有副本不能通过编辑资料改绑。
                </small>
                {account?.status !== "connected" ? (
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
            <Panel
              title="选择需要转存的文件"
              extra={
                <Button
                  disabled={busy > 0 || !accountId || !sourceText}
                  onClick={() => void inspect()}
                >
                  <ArrowDownToLine size={14} />
                  读取分享内容
                </Button>
              }
            >
              {inspection ? (
                <>
                  <div className="row folder-breadcrumb">
                    <Button
                      quiet
                      disabled={parents.length <= 1}
                      onClick={() => {
                        const next = parents.slice(0, -1);
                        setParents(next);
                        void inspect(next[next.length - 1].id);
                      }}
                    >
                      <ArrowUp size={14} />
                      上级
                    </Button>
                    <span>{parents.map((p) => p.name).join(" / ")}</span>
                    <span className="tag">已选 {selected.length} 项</span>
                  </div>
                  <div className="file-list">
                    {inspection.files.map((f) => (
                      <div className="file-row" key={f.id}>
                        <label className="checkbox">
                          <input
                            aria-label={`选择${f.name}`}
                            type="checkbox"
                            checked={selected.includes(f.id)}
                            onChange={(e) =>
                              setSelected((ids) =>
                                e.target.checked
                                  ? [...ids, f.id]
                                  : ids.filter((id) => id !== f.id),
                              )
                            }
                          />
                          {f.isDirectory ? (
                            <Folder size={16} />
                          ) : (
                            <FileIcon size={16} />
                          )}
                          <span>{f.name}</span>
                        </label>
                        <small>
                          {f.isDirectory ? "目录" : formatSize(f.size)}
                        </small>
                        {f.isDirectory ? (
                          <Button
                            quiet
                            onClick={() => {
                              const parentId =
                                provider === "baidu"
                                  ? (f.path ?? f.name)
                                  : f.id;
                              setParents((p) => [
                                ...p,
                                { id: parentId, name: f.name },
                              ]);
                              void inspect(parentId);
                            }}
                          >
                            打开
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  {inspection.hasMore ? (
                    <Button
                      onClick={() =>
                        void inspect(inspection.parentId, inspection.page + 1)
                      }
                      disabled={busy > 0}
                    >
                      加载下一页
                    </Button>
                  ) : null}
                </>
              ) : (
                <p className="muted">
                  登录并读取分享后，可以选择文件或整个目录。单次最多100个顶层项目。
                </p>
              )}
            </Panel>
          ) : (
            <Notice>
              此副本已完成归档。本页只更新资源资料，不重复转存或替换已有分享。
            </Notice>
          )}
          <label className="checkbox rights-check">
            <input
              type="checkbox"
              checked={rightsConfirmed}
              onChange={(e) => setRights(e.target.checked)}
            />
            我有权保存和分享该资源
          </label>
          <div className="actions">
            <Button
              disabled={busy > 0 || !title || !accountId || !sourceText}
              onClick={() => void save(false)}
            >
              保存资料{!existing ? "草稿" : ""}
            </Button>
            {priorCopy?.status !== "ready" ? (
              <Button
                primary
                disabled={
                  busy > 0 ||
                  !rightsConfirmed ||
                  !selected.length ||
                  !title ||
                  !accountId
                }
                onClick={() => void save(true)}
              >
                保存并开始转存 <ArrowDownToLine size={15} />
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
