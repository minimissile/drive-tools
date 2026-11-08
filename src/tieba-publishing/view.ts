export function publishingStatus(status: string): {
  label: string;
  kind: "normal" | "good" | "warning" | "danger";
} {
  switch (status) {
    case "ready":
      return { label: "待发布", kind: "normal" };
    case "submitting":
      return { label: "正在提交", kind: "normal" };
    case "verified":
      return { label: "官网已核实", kind: "good" };
    case "pending_review":
      return { label: "官网审核中", kind: "warning" };
    case "uncertain":
      return { label: "结果待核对", kind: "warning" };
    default:
      return { label: "草稿", kind: "normal" };
  }
}
export const postNumber = (value: number | null | undefined) =>
  value == null ? "未取得" : value.toLocaleString("zh-CN");
export const postDelta = (value: number | null | undefined) =>
  value == null
    ? "暂无可比记录"
    : `${value > 0 ? "+" : ""}${value.toLocaleString("zh-CN")}`;
export const publishingBackendPending = (message: string) =>
  /UNKNOWN_METHOD|未注册.*操作|不支持此操作|Unknown IPC method|尚未加载/.test(
    message,
  );
