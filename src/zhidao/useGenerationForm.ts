import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  generationColumns,
  generationRuleValues,
  defaultGenerationRules,
  guessGenerationMapping,
  mapGenerationRows,
  type GenerationMapping,
  type GenerationRules,
} from "../../shared/zhidao-generation";
import { useAppData } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAttachmentDraft } from "../hooks/useAttachmentDraft";
import { useOperationAction } from "./hooks";
import { writeDraft } from "../storage/local-draft";

const mappingSchema = z.object({
  title: z.number().int().min(-1).max(29),
  link: z.number().int().min(-1).max(29),
  code: z.number().int().min(-1).max(29),
  summary: z.number().int().min(-1).max(29),
  image: z.number().int().min(-1).max(29),
});
const tableSchema = z.object({
  name: z.string(),
  rows: z.array(z.array(z.string()).max(30)).max(501),
  mapping: mappingSchema,
  header: z.boolean(),
});
export function useGenerationForm() {
  const { data } = useAppData();
  const action = useOperationAction();
  const [legacy] = useState(() => {
    try {
      return z
        .object({
          copyIds: z.array(z.string()).max(100),
          verifyFacts: z.boolean().default(false),
        })
        .parse(
          JSON.parse(
            localStorage.getItem(`panxu-template:${data!.dataPath}`) ?? "null",
          ),
        );
    } catch {
      return null;
    }
  });
  const key = `panxu-zhidao-generation:${data!.dataPath}`;
  const form = useLocalDraft(
    key,
    {
      source: (legacy?.copyIds.length ? "owned" : "table") as "table" | "owned",
      copyIds: legacy?.copyIds ?? ([] as string[]),
      verifyFacts: legacy?.verifyFacts ?? false,
      rules: defaultGenerationRules,
    },
    (raw) =>
      z
        .object({
          source: z.enum(["table", "owned"]),
          copyIds: z.array(z.string()).max(100),
          verifyFacts: z.boolean().default(false),
          rules: generationRuleValues,
        })
        .parse(raw),
  );
  const attachment = useAttachmentDraft(
    `panxu-zhidao-generation-table:${data!.dataPath}`,
    "资源表格",
  );
  const [loadingFile, setLoadingFile] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const stored = useMemo(() => {
    if (!attachment.value) return { table: null, error: "" };
    try {
      return {
        table: tableSchema.parse(JSON.parse(attachment.value)),
        error: "",
      };
    } catch {
      return {
        table: null,
        error: "表格暂存无法读取，请重新导入文件。生成配置仍保留。",
      };
    }
  }, [attachment.value]);
  const table = stored.table;
  const mapped = useMemo(
    () =>
      table
        ? mapGenerationRows(table.rows, table.mapping, table.header)
        : { resources: [], issues: [] },
    [table],
  );
  const setMapping = (mapping: GenerationMapping) => {
    if (table) attachment.update(JSON.stringify({ ...table, mapping }));
  };
  const setHeader = (header: boolean) => {
    if (table) attachment.update(JSON.stringify({ ...table, header }));
  };
  const readFile = async (file: File) => {
    if (lock.current) return;
    if (!/\.(?:csv|xlsx)$/i.test(file.name) || file.size > 8_000_000) {
      setError("请选择8MB以内的XLSX或CSV文件，旧XLS请另存为XLSX。");
      return;
    }
    lock.current = true;
    setLoadingFile(true);
    setError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!mounted.current) return;
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 32768),
        );
      await action.run(
        "zhidao.template.read",
        { name: file.name, base64: btoa(binary) },
        (result) => {
          attachment.update(
            JSON.stringify({
              ...result,
              header: true,
              mapping: guessGenerationMapping(result.rows[0] ?? []),
            }),
          );
        },
        undefined,
        (cause) => setError(cause.message),
      );
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "文件读取失败，请重新选择。",
        );
    } finally {
      lock.current = false;
      if (mounted.current) setLoadingFile(false);
    }
  };
  const mappingIssue =
    table && (table.mapping.title < 0 || table.mapping.link < 0)
      ? "请映射资源名称与网盘链接两列。"
      : table &&
          new Set(
            generationColumns
              .map((key) => table.mapping[key])
              .filter((value) => value >= 0),
          ).size !==
            generationColumns.filter((key) => table.mapping[key] >= 0).length
        ? "不同字段不能使用同一列，请调整列映射。"
        : "";
  const saveConfig = () => {
    try {
      return writeDraft(localStorage, key, form.value);
    } catch {
      return false;
    }
  };
  const removeFile = () => {
    setError("");
    attachment.update(undefined);
  };
  return {
    form,
    attachment,
    table,
    mapped,
    mappingIssue,
    readFile,
    setMapping,
    setHeader,
    loadingFile,
    saveConfig,
    removeFile,
    error: error || stored.error || attachment.error,
    updateRules: (patch: Partial<GenerationRules>) =>
      form.update({ rules: { ...form.value.rules, ...patch } }),
  };
}
export type GenerationForm = ReturnType<typeof useGenerationForm>;
