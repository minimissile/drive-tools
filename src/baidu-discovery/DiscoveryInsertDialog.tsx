import { AiIcon } from "../ui/AiIcon";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, FolderTree, X } from "lucide-react";
import { z } from "zod";
import type { DiscoveryRun } from "../../shared/baidu-discovery";
import type { QuestionDraftInsertResult } from "../../shared/zhidao-publishing";
import { useAppData } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { ipc } from "../api/client";
import { Dialog } from "../ui/Dialog";
import { Button, Field, Notice } from "../ui/primitives";
import { readMaterialBrief } from "./material-brief";
import { OwnedResourcePicker } from "../zhidao/OwnedResourcePicker";
import { useIpcQuery } from "../api/useIpcQuery";
import { QueryError } from "../ui/QueryError";
import { QuestionImportProgress } from "./QuestionImportProgress";

const schema = z.object({
  copyIds: z.array(z.string()).max(100).default([]),
  brief: z.string().max(6000),
  count: z.number(),
  materials: z.string().max(210000),
});
const splitMaterials = (text: string) =>
  text
    .split(/^\s*---+\s*$/m)
    .map((value) => value.trim())
    .filter(Boolean);
export function DiscoveryInsertDialog({
  workspace,
  run,
  keys,
  onClose,
  onInserted,
}: {
  workspace: string;
  run: DiscoveryRun;
  keys: string[];
  onClose(): void;
  onInserted(result: QuestionDraftInsertResult): void;
}) {
  const { data } = useAppData();
  const draft = useLocalDraft(
    `panxu-baidu-discovery-insert:${workspace}:${run.id}`,
    {
      copyIds: [] as string[],
      brief: run.materialPool?.brief || "",
      count: 3,
      materials: run.materialPool?.entries.join("\n\n---\n\n") || "",
    },
    (value) => schema.parse(value),
  );
  const { value, update } = draft;
  const materials = splitMaterials(value.materials);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [pausing, setPausing] = useState(false);
  const progress = useIpcQuery(
    "baiduDiscovery.questionImport",
    { id: run.id },
    {
      keepPrevious: true,
      refreshInterval: 1500,
    },
  );
  const busy = !!pending || !!progress.data?.running;
  const [fileProgress, setFileProgress] = useState("");
  const [fileBrowserIssue, setFileBrowserIssue] = useState(false);
  const [generationWarnings, setGenerationWarnings] = useState(() =>
    run.materialPool?.entries.join("\n\n---\n\n") === value.materials
      ? run.materialPool.warnings || []
      : [],
  );
  const fileReading = useRef<AbortController | null>(null);
  useEffect(() => () => fileReading.current?.abort(), []);
  const lock = useRef(false);
  const act = async (kind: string, action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setPending(kind);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请重试。");
    } finally {
      lock.current = false;
      setPending("");
    }
  };
  const generate = () =>
    void act("generate", async () => {
      if (!value.brief.trim())
        throw new Error(
          "请填写资料主题、实际内容与适用对象，AI将据此生成文案。",
        );
      if (!Number.isInteger(value.count) || value.count < 1 || value.count > 10)
        throw new Error("生成篇数需为1–10篇。");
      const pool = await ipc("baiduDiscovery.generateMaterials", {
        id: run.id,
        keys,
        brief: value.brief,
        count: value.count,
        authorized: true,
      });
      update({ materials: pool.entries.join("\n\n---\n\n") });
      setGenerationWarnings(pool.warnings || []);
    });
  const generateBrief = () =>
    void act("filenames", async () => {
      const controller = new AbortController();
      fileReading.current = controller;
      setFileBrowserIssue(false);
      setFileProgress("正在识别链接…");
      try {
        const resources = await ipc("zhidao.template.sources", {
          copyIds: value.copyIds,
        });
        const result = await readMaterialBrief({
          links: resources
            .map(
              (resource) =>
                `${resource.link}${resource.code ? ` 提取码：${resource.code}` : ""}`,
            )
            .join("\n"),
          signal: controller.signal,
          onProgress: setFileProgress,
        });
        update({ brief: result.brief });
        setFileProgress(
          `已读取 ${result.packageCount} 个资源包、${result.nameCount} 个文件与文件夹名称${result.sampled ? "，依据已节选，可编辑补充。" : "，可编辑补充。"}`,
        );
      } catch (cause) {
        if (controller.signal.aborted) {
          setFileProgress("已停止读取，原有资料依据已保留。");
          return;
        }
        setFileProgress("");
        const code =
          cause instanceof Error && "code" in cause ? String(cause.code) : "";
        setFileBrowserIssue(
          (code.startsWith("SHARE_") && code !== "SHARE_BROWSER_BUSY") ||
            code === "BAD_CODE",
        );
        throw cause;
      } finally {
        fileReading.current = null;
      }
    });
  const insert = () =>
    void act("insert", async () => {
      setPausing(false);
      if (!value.copyIds.length)
        throw new Error("请先选择关联的本人百度网盘资源。");
      if (
        !materials.length ||
        materials.some((material) => material.length > 2000) ||
        materials.length > 100
      )
        throw new Error("请准备1–100篇资料文案，每篇不超过2000字。");
      const result = await ipc("baiduDiscovery.insertZhidao", {
        id: run.id,
        keys,
        copyIds: value.copyIds,
        materials,
      });
      progress.reload();
      onInserted(result);
    });
  return (
    <Dialog
      title="配资料并生成独立链接"
      onClose={onClose}
      busy={busy}
      className="baidu-discovery-insert-dialog"
      footer={
        <>
          <span>{keys.length} 个关键词 · 每词一条新分享 · 同名问题跳过</span>
          {progress.data?.running ? (
            <Button
              disabled={pausing}
              onClick={() => {
                setPausing(true);
                void ipc("baiduDiscovery.pauseQuestionImport", {
                  id: run.id,
                }).catch((cause) => {
                  setPausing(false);
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "暂停未完成，请重试。",
                  );
                });
              }}
            >
              {pausing ? "等待当前分享结果…" : "暂停建链"}
            </Button>
          ) : null}
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            primary
            disabled={
              busy ||
              !progress.data ||
              !!progress.error ||
              !value.copyIds.length ||
              !materials.length ||
              keys.length > 500
            }
            onClick={insert}
          >
            {pending === "insert" || progress.data?.running
              ? "正在逐词建链…"
              : "生成独立链接并入表"}
          </Button>
        </>
      }
    >
      <div className="baidu-material-layout">
        <section className="baidu-material-inputs" aria-label="链接与生成设置">
          <Field label="关联百度网盘资源" hint="选择已核验的本人资源" as="div">
            <OwnedResourcePicker
              selected={value.copyIds}
              disabled={busy}
              showLinks={false}
              onChange={(copyIds) => {
                update({ copyIds });
                setFileProgress("");
              }}
            />
          </Field>
          <p className="baidu-discovery-caption">
            入表时为每个长尾词创建永久分享，链接只随问答保存，不新增资源库记录，也不替换原链接。多份资源按数量均衡分配。
          </p>
          {keys.length > 500 ? (
            <Notice warning>每次最多500个长尾词，请关闭后分批选择。</Notice>
          ) : null}
          <section
            className="baidu-material-generator"
            aria-label="AI生成资料文案"
          >
            <Field
              label="资料主题与依据"
              hint="可编辑，或从包内文件、文件夹名称整理"
              as="div"
            >
              <div className="baidu-material-brief-actions">
                <Button
                  size="compact"
                  disabled={busy || !value.copyIds.length}
                  onClick={generateBrief}
                >
                  <FolderTree size={14} />
                  {pending === "filenames"
                    ? "正在读取包内名称…"
                    : "按文件名生成依据"}
                </Button>
                {pending === "filenames" ? (
                  <Button
                    quiet
                    size="compact"
                    onClick={() => fileReading.current?.abort()}
                  >
                    停止读取
                  </Button>
                ) : null}
                <small>后台读取，含子文件夹</small>
              </div>
              <textarea
                aria-label="资料主题与依据"
                rows={4}
                maxLength={6000}
                disabled={busy}
                value={value.brief}
                onChange={(event) => {
                  update({ brief: event.target.value });
                  setFileProgress("");
                }}
              />
              {fileProgress ? (
                <small className="baidu-material-brief-status" role="status">
                  {fileProgress}
                </small>
              ) : null}
            </Field>
            {fileBrowserIssue ? (
              <div className="baidu-material-browser-actions">
                <Button
                  size="compact"
                  disabled={busy}
                  onClick={() =>
                    void act("viewShare", () =>
                      ipc("baiduDiscovery.openShareBrowser"),
                    )
                  }
                >
                  <ExternalLink size={14} />
                  查看异常页面
                </Button>
                <Button
                  quiet
                  size="compact"
                  disabled={busy}
                  onClick={() =>
                    void act("closeShare", async () => {
                      await ipc("baiduDiscovery.closeShareBrowser");
                      setFileBrowserIssue(false);
                    })
                  }
                >
                  <X size={14} />
                  结束读取会话
                </Button>
              </div>
            ) : null}
            <div className="baidu-material-generate-actions">
              <Field label="生成篇数" hint="1–10篇">
                <input
                  type="number"
                  min={1}
                  max={10}
                  aria-label="资料生成篇数"
                  disabled={busy}
                  value={value.count || ""}
                  onChange={(event) =>
                    update({ count: Number(event.target.value) })
                  }
                />
              </Field>
              <Button disabled={busy || !value.brief.trim()} onClick={generate}>
                <AiIcon size={14} />
                {pending === "generate"
                  ? `正在生成 ${value.count} 篇…`
                  : `AI生成 ${value.count} 篇文案`}
              </Button>
            </div>
            <small>
              模型：{data?.settings.aiModels.copy || "尚未配置"} ·
              点击生成会产生模型费用
            </small>
          </section>
          {error || draft.error ? (
            <Notice danger>{error || draft.error}</Notice>
          ) : null}
          <QueryError
            error={
              progress.error === "不支持此操作。"
                ? "请先点击窗口顶部“应用更新并重启”，加载本次建链功能后重试。"
                : progress.error
            }
            loading={progress.loading}
            onRetry={progress.reload}
          />
          {progress.data?.total ? (
            <QuestionImportProgress
              value={progress.data}
              disabled={busy}
              onChanged={progress.reload}
            />
          ) : null}
        </section>
        <section className="baidu-material-editor" aria-label="编辑待分配文案">
          <div className="baidu-material-editor-heading">
            <h3>资料文案池</h3>
            <span>{materials.length} 篇文案</span>
          </div>
          <p className="baidu-discovery-caption">
            可手动编写或编辑 AI 结果，每篇用单独一行 --- 分隔。
          </p>
          <div className="baidu-material-editor-field">
            <textarea
              aria-label="资料文案池"
              rows={13}
              maxLength={210000}
              disabled={busy}
              value={value.materials}
              placeholder={
                "第一篇资料文案，写明内容、适用对象与使用方法。\n\n---\n\n第二篇资料文案。"
              }
              onChange={(event) => {
                update({ materials: event.target.value });
                setGenerationWarnings([]);
              }}
            />
          </div>
          {generationWarnings.length ? (
            <Notice warning>{generationWarnings.join(" ")}</Notice>
          ) : null}
          {run.materialPool ? (
            <Button
              quiet
              size="compact"
              disabled={busy}
              onClick={() => {
                update({
                  brief: run.materialPool!.brief,
                  materials: run.materialPool!.entries.join("\n\n---\n\n"),
                });
                setGenerationWarnings(run.materialPool!.warnings || []);
              }}
            >
              载入上次AI生成的 {run.materialPool.entries.length} 篇文案
            </Button>
          ) : null}
          <p className="baidu-discovery-caption">
            文案均衡分配，每个词单独建链；成功后可直接前往问答发布页审核上传。未完成项保留进度，再次点击可继续。
          </p>
        </section>
      </div>
    </Dialog>
  );
}
