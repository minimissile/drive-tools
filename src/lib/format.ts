export const formatMoney = (value: number | null, currency = "CNY") =>
  value == null
    ? "未配置"
    : `${currency === "USD" ? "$" : "¥"}${(value / 1_000_000).toFixed(currency === "USD" ? 6 : 4)}`;
export const formatTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未提供";
export const formatSize = (value: number | null) =>
  value == null
    ? "未提供"
    : value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(2)} GB`
      : value >= 1024 ** 2
        ? `${(value / 1024 ** 2).toFixed(1)} MB`
        : `${Math.ceil(value / 1024)} KB`;
