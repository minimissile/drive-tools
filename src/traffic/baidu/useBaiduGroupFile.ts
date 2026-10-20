import { useMemo, useState } from "react";
import { z } from "zod";
import { useAttachmentDraft } from "../../hooks/useAttachmentDraft";
import { ipc } from "../../api/client";
const schema = z.object({
  name: z.string().max(200),
  base64: z.string().max(10_666_672),
});
export function useBaiduGroupFile(workspace: string, accountId: string) {
  const attachment = useAttachmentDraft(
    `baidu-group-file:${workspace}:${accountId}`,
    "关键词文件",
  );
  const [uploaded, setUploaded] = useState<{
      bosKey: string;
      fileName: string;
    } | null>(null),
    [reading, setReading] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState("");
  const file = useMemo(() => {
    try {
      return schema.parse(JSON.parse(attachment.value ?? ""));
    } catch {
      return null;
    }
  }, [attachment.value]);
  const choose = async (file: File | null) => {
    setUploaded(null);
    setError("");
    if (!file) {
      attachment.update(undefined);
      return;
    }
    if (!/\.xlsx$/i.test(file.name) || file.size > 8_000_000) {
      setError("请选择不超过8MB的XLSX文件。");
      return;
    }
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      attachment.update(JSON.stringify({ name: file.name, base64: btoa(s) }));
    } catch {
      setError("文件读取失败，请重新选择。");
    } finally {
      setReading(false);
    }
  };
  const upload = async () => {
    if (!file || uploading) return;
    setUploading(true);
    setError("");
    try {
      setUploaded(await ipc("baiduResearch.upload", { accountId, ...file }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传未完成。");
    } finally {
      setUploading(false);
    }
  };
  return {
    file,
    uploaded,
    choose,
    upload,
    busy: reading || uploading || attachment.loading,
    uploading,
    error: error || attachment.error,
  };
}
