import { providerIds, providerSpecs } from "../../shared/providers";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { FileImage, Sparkles, Trash2 } from "lucide-react";
import {
  Button,
  Empty,
  Field,
  Loading,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { useAppData, useAppActions, useAppNavigation } from "../state";

import type { ExportModel } from "./useResourceExport";
const stateNames = {
  planned: "等待确认",
  running: "正在筛选",
  paused: "可继续",
  completed: "筛选完成",
  failed: "等待重试",
};
const examples = [
  "导出所有英语教学资料，包含少儿英语、口语、语法和备考资料，按资源名称、分类、文件格式、资源说明整理，并写一篇300字的推荐短文。",
  "筛选编程学习资料中包含 PDF 的资源，导出名称、标签、文件清单和保存账号。",
  "按参考截图的表头和顺序导出英语教学资源，没有对应信息的列留空。",
];
export function ExportRequest({ model }: { model: ExportModel }) {
  const { data } = useAppData();
  const { command } = useAppActions();
  const { navigate } = useAppNavigation();
  const {
    request,
    setRequest,
    images,
    setImages,
    missingImages,
    planError,
    scope,
    setScope,
    category,
    setCategory,
    provider,
    setProvider,
    accountId,
    setAccountId,
    archivedOnly,
    setArchivedOnly,
    history,
    run,
    working,
    setWorking,
    loading,
    imageInput,
    adopt,
    locked,
    addImages,
    createPlan,
  } = model;
  return (
    <div className="export-request-column">
      <Panel title="01 / 描述导出需求" extra={<small>文字 + 图片</small>}>
        <fieldset disabled={locked} className="export-fieldset">
          <Field label="导出需求">
            <textarea
              aria-label="导出需求"
              value={request}
              maxLength={6000}
              rows={7}
              placeholder="例如：导出所有英语教学资料，按截图中的列顺序整理，再写一篇面向英语老师的资料介绍。"
              onChange={(e) => setRequest(e.target.value)}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length) {
                  e.preventDefault();
                  void addImages(files);
                }
              }}
            />
          </Field>
          <div className="export-examples">
            {examples.map((s, i) => (
              <button key={s} type="button" onClick={() => setRequest(s)}>
                {["英语教学 + 短文", "按文件格式筛选", "参考截图表头"][i]}
              </button>
            ))}
          </div>
          <div
            className="export-dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void addImages([...e.dataTransfer.files]);
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                void addImages([...e.clipboardData.files]);
              }
            }}
            tabIndex={0}
            aria-label="参考截图上传区域"
          >
            <FileImage size={22} />
            <p>拖入或粘贴参考截图</p>
            <small>最多3张，用于识别表头与列顺序</small>
            <Button
              disabled={images.length >= 3}
              onClick={() => imageInput.current?.click()}
            >
              选择图片
            </Button>
            <input
              hidden
              ref={imageInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(e) => {
                void addImages([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </div>
          {images.length ? (
            <div className="export-images">
              {images.map((v, i) => (
                <div key={i}>
                  <img src={v.data} alt={`参考截图${i + 1}：${v.name}`} />
                  <Button
                    quiet
                    aria-label={`移除参考截图${i + 1}`}
                    onClick={() =>
                      setImages((old) => old.filter((_, n) => n !== i))
                    }
                  >
                    <Trash2 size={13} /> 移除
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <Field label="检索范围">
            <Select
              aria-label="导出检索范围"
              value={scope}
              onValueChange={(nextValue) => setScope(nextValue as typeof scope)}
              items={[
                { value: "combined", label: "资源数据库 + 知识笔记" },
                { value: "database", label: "仅资源数据库" },
                { value: "notes", label: "仅有知识笔记的资源" },
              ]}
            />
          </Field>
          <details>
            <summary>限定分类、网盘与账号</summary>
            <div className="export-scope-fields">
              <Field label="分类">
                <Select
                  aria-label="导出分类"
                  value={category}
                  onValueChange={(nextValue) => setCategory(nextValue)}
                  items={[
                    { value: "all", label: "全部分类" },
                    ...data!.resourceTotals.categories.map((c) => ({
                      value: c,
                      label: c,
                    })),
                  ]}
                />
              </Field>
              <Field label="网盘">
                <Select
                  aria-label="导出网盘"
                  value={provider}
                  onValueChange={(nextValue) => {
                    setProvider(nextValue as typeof provider);
                    setAccountId("all");
                  }}
                  items={[
                    { value: "all", label: "全部网盘" },
                    ...providerIds.map((value) => ({
                      value,
                      label: providerSpecs[value].name,
                    })),
                  ]}
                />
              </Field>
              <Field label="保存账号">
                <Select
                  aria-label="导出账号"
                  value={accountId}
                  onValueChange={(nextValue) => setAccountId(nextValue)}
                  items={[
                    { value: "all", label: "全部账号" },
                    ...data!.accounts
                      .filter(
                        (a) => provider === "all" || a.provider === provider,
                      )
                      .map((a) => ({ value: a.id, label: a.alias })),
                  ]}
                />
              </Field>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={archivedOnly}
                  onChange={(e) => setArchivedOnly(e.target.checked)}
                />
                仅已归档资源
              </label>
            </div>
          </details>
        </fieldset>
        <p className="export-disclosure">
          提交后使用当前 OpenRouter
          模型和美元预算。图片及所选范围的资源文字、个人笔记片段会发送给模型；图片请先遮盖敏感信息。知识库仅含盘序关联的资源笔记。
        </p>
        {missingImages > 0 && !images.length ? (
          <Notice warning>
            上次参考图片未保存在磁盘，请重新添加后再提交截图需求；已生成的方案和结果仍保留。
          </Notice>
        ) : null}
        {planError ? (
          <Notice warning>
            需求解析未完成：{planError}。本次输入和已有结果已保留。
            <Button quiet onClick={() => navigate("settings")}>
              调整模型配置
            </Button>
          </Notice>
        ) : null}
        {!data!.settings.aiModels[images.length ? "vision" : "analysis"] ? (
          <Notice>
            请先选择 AI 模型。
            <Button quiet onClick={() => navigate("settings")}>
              连接与设置
            </Button>
          </Notice>
        ) : (
          <small>
            当前模型：
            {data!.settings.aiModels[images.length ? "vision" : "analysis"]} ·
            按任务自动选择分析或截图理解模型
          </small>
        )}
        {!data!.settings.openrouterConfigured ? (
          <Notice warning>
            尚未配置OpenRouter密钥。输入会暂存在本机，接入后可继续。
            <Button quiet onClick={() => navigate("settings")}>
              连接AI服务
            </Button>
          </Notice>
        ) : null}
        <Button
          primary
          disabled={
            locked ||
            !data!.settings.openrouterConfigured ||
            (!request.trim() && !images.length) ||
            !data!.settings.aiModels[images.length ? "vision" : "analysis"]
          }
          onClick={() => void createPlan()}
        >
          <Sparkles size={15} />
          {working ? "正在处理…" : "解析需求与表头"}
        </Button>
      </Panel>
      {model.historyError && !run && !history.length && !loading ? null : (
        <Panel
          title="最近导出"
          extra={
            loading && history.length ? (
              <Loading label="正在更新导出记录…" />
            ) : (
              <small>保留20次，可离线查看</small>
            )
          }
        >
          <QueryError
            error={run ? model.historyError : ""}
            loading={loading}
            onRetry={model.retryHistory}
          />
          {loading && !history.length ? (
            <LoadingState label="正在读取导出记录…" compact />
          ) : history.length ? (
            <div className="export-history">
              {history.map((h) => (
                <button
                  key={h.id}
                  disabled={locked}
                  className={run?.id === h.id ? "selected" : ""}
                  onClick={async () => {
                    setWorking(true);
                    try {
                      const r = await command("resourceExport.get", {
                        runId: h.id,
                      });
                      if (r) adopt(r);
                    } finally {
                      setWorking(false);
                    }
                  }}
                >
                  <strong>{h.plan.title}</strong>
                  <small>
                    {stateNames[h.state]} · {h.scanned}/{h.total} 份 ·{" "}
                    {new Date(h.createdAt).toLocaleString("zh-CN")}
                  </small>
                </button>
              ))}
            </div>
          ) : model.historyError ? null : (
            <Empty title="还没有导出记录" compact>
              第一次导出的方案和结果会保存在这里。
            </Empty>
          )}
        </Panel>
      )}
    </div>
  );
}
