export interface ModelPriceLine {
  billable: string;
  unit: string;
  usd: number;
  variant?: string;
  provider?: string;
}

export function usd(value: number): string {
  return `$${Number(value.toFixed(8))}`;
}

export function priceLineText(line: ModelPriceLine): string {
  const names: Record<string, string> = {
    output_image: "生成图片",
    input_image: "输入图片",
    input_text: "输入文字",
    output_video: "生成视频",
    input_reference: "参考图",
    input_video: "输入视频",
    minimum_generation: "最低单次费用",
  };
  const units: Record<string, string> = {
    image: "张",
    second: "秒",
    megapixel: "百万像素",
    request: "次",
  };
  return `${names[line.billable] ?? line.billable}${line.variant ? `（${line.variant}）` : ""} ${usd(line.unit === "token" ? line.usd * 1e6 : line.usd)}/${line.unit === "token" ? "百万令牌" : (units[line.unit] ?? line.unit)}${line.provider ? ` · ${line.provider}` : ""}`;
}
