// Province IDs and names verified in Baidu commonLibs/74027 and toolsCenter/3539.
export const baiduProvinces: [number, string][] = [
  [1000, "北京"],
  [2000, "上海"],
  [3000, "天津"],
  [4000, "广东"],
  [5000, "福建"],
  [8000, "海南"],
  [9000, "安徽"],
  [10000, "贵州"],
  [11000, "甘肃"],
  [12000, "广西"],
  [13000, "河北"],
  [14000, "河南"],
  [15000, "黑龙江"],
  [16000, "湖北"],
  [17000, "湖南"],
  [18000, "吉林"],
  [19000, "江苏"],
  [20000, "江西"],
  [21000, "辽宁"],
  [22000, "内蒙古"],
  [23000, "宁夏"],
  [24000, "青海"],
  [25000, "山东"],
  [26000, "山西"],
  [27000, "陕西"],
  [28000, "四川"],
  [29000, "西藏"],
  [30000, "新疆"],
  [31000, "云南"],
  [32000, "浙江"],
  [33000, "重庆"],
  [34000, "香港"],
  [35000, "台湾"],
  [36000, "澳门"],
];
export const splitBaiduWords = (s: string) => [
  ...new Set(
    s
      .split(/[,，;；\n]/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
export function treeOptions(
  data: unknown,
  kind: "business" | "industry" = "business",
) {
  const result: { value: string; label: string; path: string[] }[] = [];
  const visit = (value: unknown, path: string[], depth: number) => {
    if (depth > 10 || result.length > 20000) return;
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, path, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    const v = value as Record<string, unknown>;
    const label = String(
      v.label ??
        v.businessPointName ??
        v.businesspointName ??
        v.tradeName ??
        v.name ??
        "",
    );
    const id = v.value ?? v.businessPointId ?? v.businesspointid ?? v.id;
    const next = label ? [...path, label] : path;
    const children =
      v.children ?? v.subTrade ?? v.businessPoints ?? v.tradeNodeList ?? v.list;
    if (
      label &&
      (kind === "industry" ||
        (id !== undefined && !(Array.isArray(children) && children.length))) &&
      v.enable !== false &&
      v.disabled !== true &&
      v.showType !== 999
    )
      result.push({
        value: kind === "industry" ? next.join(" / ") : String(id),
        label: next.join(" / "),
        path: next,
      });
    if (children) visit(children, next, depth + 1);
  };
  visit(data, [], 0);
  return result;
}
export function baiduMetric(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return "—";
  if (/(?:Id|id)$/.test(field)) return String(value);
  if (
    [
      "competition",
      "competitionPc",
      "competitionWise",
      "kwc",
      "intentionLevel",
    ].includes(field)
  )
    return (
      ({ 1: "高", 2: "中", 3: "低" } as Record<string, string>)[
        String(value)
      ] ?? String(value)
    );
  if (field === "status")
    return (
      (
        { 0: "处理中", 1: "完成", 2: "失败", 3: "已取消" } as Record<
          string,
          string
        >
      )[String(value)] ?? String(value)
    );
  if (field === "searchRate" && typeof value === "number")
    return `${(value * 100).toFixed(2)}%`;
  if (
    field.startsWith("averageMonthPv") &&
    Number.isFinite(Number(value)) &&
    Number(value) < 5
  )
    return "<5";
  if (field.startsWith("recommendPrice") && typeof value === "number")
    return `${value.toFixed(2)} 元`;
  return typeof value === "number"
    ? value.toLocaleString("zh-CN")
    : String(value);
}
