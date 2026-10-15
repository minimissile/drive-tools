import { useState } from "react";
import {
  Button,
  Field,
  Header,
  Notice,
  Panel,
  providerName,
} from "../components";
import { useApp } from "../state";
import type { ImportPreview, Provider } from "../../shared/types";
export default function Bulk() {
  const { data, command, busy, navigate } = useApp();
  const [text, setText] = useState(""),
    [targets, setTargets] = useState<Partial<Record<Provider, string>>>({}),
    [preview, setPreview] = useState<ImportPreview | null>(null),
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
      <Header
        title="一次整理多份资源，逐份核验后转存。"
        description="CSV预检会识别账号、重复链接和错误行；导入后先保存在本地资料草稿。"
      />
      <Notice>
        导入只建立本地草稿。之后可进入批量转存，统一读取分享、调整文件选择并确认目标账号后开始任务。
      </Notice>
      <Panel title="导入CSV">
        <div className="row">
          <Button
            disabled={busy > 0}
            onClick={async () => {
              const file = await command<{ name: string; text: string } | null>(
                "resource.importFile",
              );
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
            className="content-textarea"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              reset();
            }}
            placeholder="标题,链接,分类,标签,说明,账号,提取码"
          />
        </Field>
        <div className="field-pair">
          {(["quark", "baidu"] as const).map((provider) => (
            <Field key={provider} label={`${providerName(provider)}目标账号`}>
              <select
                aria-label={`${providerName(provider)}导入账号`}
                value={targets[provider] ?? ""}
                onChange={(e) => {
                  setTargets((old) => ({
                    ...old,
                    [provider]: e.target.value || undefined,
                  }));
                  reset();
                }}
              >
                <option value="">使用该网盘默认账号</option>
                {data!.accounts
                  .filter((a) => a.provider === provider && a.enabled)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.alias}
                    </option>
                  ))}
              </select>
            </Field>
          ))}
        </div>
        <Button
          primary
          disabled={!text.trim() || busy > 0}
          onClick={async () => {
            const result = await command<ImportPreview>(
              "resource.importPreview",
              { text, targets },
            );
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
                            e.target.checked
                              ? [...old, r.row]
                              : old.filter((n) => n !== r.row),
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
                const result = await command<typeof report>(
                  "resource.importCommit",
                  { token: preview.token, rows: selected },
                );
                if (result) setReport(result);
              }}
            >
              导入所选{selected.length}份资料草稿
            </Button>
            <Button onClick={() => navigate("library")}>返回资源库</Button>
            {report?.copyIds.length ? (
              <Button
                onClick={() => {
                  localStorage.setItem(
                    "panxu-batch-seed",
                    JSON.stringify(report.copyIds.slice(0, 100)),
                  );
                  navigate("batch");
                }}
              >
                将已导入资料加入批量转存
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
