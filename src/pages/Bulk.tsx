import { Select } from "../ui/Select";
import { z } from "zod";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { updateSelection } from "../lib/selection";
import { providerIds } from "../../shared/providers";
import { useState } from "react";
import { Button, Field, Header, Notice, Panel } from "../ui/primitives";
import { providerName } from "../resources/labels";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "../state";
import type { ImportPreview, Provider } from "../../shared/types";
export default function Bulk({
  embedded = false,
  onImported,
}: {
  embedded?: boolean;
  onImported?: (ids: string[]) => void;
}) {
  const { data } = useAppData(),
    { navigate } = useAppNavigation(),
    { command } = useAppActions(),
    { busy } = useAppActivity();
  const draft = useLocalDraft(
    `panxu-bulk-v1:${data!.dataPath}`,
    { text: "", targets: {} as Partial<Record<Provider, string>> },
    parseBulkDraft,
  );
  const { text, targets } = draft.value;
  const setText = (text: string) => draft.update({ text });
  const [preview, setPreview] = useState<ImportPreview | null>(null),
    [selected, setSelected] = useState<number[]>([]),
    [report, setReport] = useState<{
      created: number;
      skipped: number;
      failed: number;
      errors: { row: number; message: string }[];
      copyIds: string[];
    } | null>(null);
  const reset = () => {
    setPreview(null);
    setSelected([]);
    setReport(null);
  };
  return (
    <>
      {!embedded && (
        <Header
          title="一次整理多份资源，逐份核验后转存。"
          description="CSV预检会识别账号、重复链接和错误行；导入后先保存在本地资料草稿。"
        />
      )}
      {draft.error ? (
        <Notice danger>{draft.error}</Notice>
      ) : draft.restored ? (
        <Notice>已恢复未导入的CSV输入。请重新预检，再确认导入。</Notice>
      ) : null}
      <Notice>
        导入先建立本地草稿。继续到“检查并转存”读取分享、选择文件并确认目标账号；也可以仅导入，稍后处理。
      </Notice>
      <Panel title="导入CSV" className="bulk-input-panel">
        <div className="row">
          <Button
            disabled={busy > 0}
            onClick={async () => {
              const file = await command("resource.importFile");
              if (file) {
                setText(file.text);
                reset();
              }
            }}
          >
            选择UTF-8 CSV文件
          </Button>
          <small>
            必填列：标题、链接、分类。可选：标签、说明、账号、提取码。最多500行、2MB。
          </small>
        </div>
        <Field label="CSV内容">
          <textarea
            aria-label="批量资源CSV"
            className="bulk-csv-input"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              reset();
            }}
            placeholder="标题,链接,分类,标签,说明,账号,提取码"
          />
        </Field>
        <div className="field-pair">
          {providerIds.map((provider) => (
            <Field key={provider} label={`${providerName(provider)}目标账号`}>
              <Select
                aria-label={`${providerName(provider)}导入账号`}
                value={targets[provider] ?? ""}
                onValueChange={(nextValue) => {
                  draft.update({
                    targets: {
                      ...targets,
                      [provider]: nextValue || undefined,
                    },
                  });
                  reset();
                }}
                items={[
                  { value: "", label: "使用该网盘默认账号" },
                  ...data!.accounts
                    .filter((a) => a.provider === provider && a.enabled)
                    .map((a) => ({ value: a.id, label: a.alias })),
                ]}
              />
            </Field>
          ))}
        </div>
        <Button
          primary
          disabled={!text.trim() || busy > 0}
          onClick={async () => {
            const result = await command("resource.importPreview", {
              text,
              targets,
            });
            if (result) {
              setPreview(result);
              setReport(null);
              setSelected(
                result.rows
                  .filter((r) => r.status === "new" || r.status === "copy")
                  .map((r) => r.row),
              );
            }
          }}
        >
          预检CSV
        </Button>
      </Panel>
      {preview ? (
        <Panel title={`预检结果 · ${preview.rows.length}行`}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>选择</th>
                  <th>CSV行</th>
                  <th>资源</th>
                  <th>目标账号</th>
                  <th>处理</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.row}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择CSV第${r.row}行`}
                        disabled={
                          r.status === "skip" ||
                          r.status === "invalid" ||
                          !!report
                        }
                        checked={selected.includes(r.row)}
                        onChange={(e) =>
                          setSelected((old) =>
                            updateSelection(old, [r.row], e.target.checked),
                          )
                        }
                      />
                    </td>
                    <td>{r.row}</td>
                    <td>
                      {r.title || "标题为空"}
                      <br />
                      <small>
                        {r.provider ? providerName(r.provider) : "无法识别网盘"}
                      </small>
                    </td>
                    <td>{r.account || "未确定"}</td>
                    <td>
                      {r.status === "invalid"
                        ? "格式错误"
                        : r.status === "skip"
                          ? "跳过"
                          : r.status === "copy"
                            ? "新账号副本"
                            : "新资源"}
                      <small className="table-note">{r.message}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <Button
              primary
              disabled={!selected.length || busy > 0 || !!report}
              onClick={async () => {
                const result = await command("resource.importCommit", {
                  token: preview.token,
                  rows: selected,
                });
                if (result) {
                  setReport(result);
                  if (!result.failed) draft.clear();
                }
              }}
            >
              导入所选{selected.length}份资料草稿
            </Button>
            <Button onClick={() => navigate("library")}>返回资源库</Button>
            {report?.copyIds.length ? (
              <Button
                onClick={() => {
                  if (onImported) {
                    onImported(report.copyIds);
                    return;
                  }
                  localStorage.setItem(
                    "panxu-batch-seed",
                    JSON.stringify(report.copyIds.slice(0, 100)),
                  );
                  navigate("batch");
                }}
              >
                继续检查并转存
                {report.copyIds.length > 100 ? "（先选前100份）" : ""}
              </Button>
            ) : null}
          </div>
          {report ? (
            <Notice warning={report.failed > 0}>
              已新增{report.created}份草稿，跳过{report.skipped}份，失败
              {report.failed}份。
              {report.errors.map((e) => (
                <p key={e.row}>
                  第{e.row}行：{e.message}
                </p>
              ))}
            </Notice>
          ) : null}
        </Panel>
      ) : null}
    </>
  );
}

const parseBulkDraft = (value: unknown) =>
  z
    .object({
      text: z.string(),
      targets: z.partialRecord(z.enum(providerIds), z.string()),
    })
    .parse(value);
