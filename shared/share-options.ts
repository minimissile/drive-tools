import type { Provider } from "./types";

export interface ShareCreationOptions {
  /** 0 means permanent. */
  expiresInDays: number;
  /** Empty creates a random extraction code on providers supporting private links. */
  extractionCode?: string;
}

export interface ProviderShareCreationCapabilities {
  supported: boolean;
  expiryOptions: readonly { days: number; label: string }[];
  extractionCode: {
    mode: "custom" | "automatic" | "none";
    length?: number;
    pattern?: string;
    description: string;
  };
  note?: string;
}

const standardExpiryOptions = [
  { days: 0, label: "永久有效" },
  { days: 1, label: "1天" },
  { days: 7, label: "7天" },
  { days: 30, label: "30天" },
] as const;
const fourCharacterCode = {
  mode: "custom" as const,
  length: 4,
  pattern: "^[A-Za-z0-9]{4}$",
  description: "4位英文字母或数字，留空自动生成",
};
const configurable: ProviderShareCreationCapabilities = {
  supported: true,
  expiryOptions: standardExpiryOptions,
  extractionCode: fourCharacterCode,
};

/** Only settings implemented by the corresponding provider are offered. */
export const shareCreationCapabilities: Record<
  Provider,
  ProviderShareCreationCapabilities
> = {
  quark: configurable,
  uc: configurable,
  baidu: configurable,
  xunlei: {
    supported: true,
    expiryOptions: standardExpiryOptions.filter((option) => option.days !== 30),
    extractionCode: { mode: "automatic", description: "提取码由迅雷自动生成" },
    note: "当前支持永久、1天或7天有效，暂不支持自定义提取码。",
  },
  guangya: {
    supported: true,
    expiryOptions: standardExpiryOptions.filter((option) => option.days === 0),
    extractionCode: { mode: "automatic", description: "使用光鸭生成的提取码" },
    note: "当前仅支持永久有效，暂不支持自定义提取码。",
  },
  pikpak: {
    supported: true,
    expiryOptions: standardExpiryOptions,
    extractionCode: { mode: "none", description: "公开链接，不设置提取码" },
    note: "当前创建无需提取码的公开链接，暂不支持自定义提取码。",
  },
};

/** Shared by the form and provider validation; never silently drops settings. */
export function shareCreationOptionsError(
  provider: Provider,
  options: ShareCreationOptions,
): string | null {
  const capability = shareCreationCapabilities[provider];
  if (!capability.supported)
    return capability.note ?? "此网盘暂不支持创建独立分享。";
  if (
    !Number.isInteger(options.expiresInDays) ||
    !capability.expiryOptions.some(
      (item) => item.days === options.expiresInDays,
    )
  )
    return "此网盘不支持所选有效期，请重新选择。";
  const code = options.extractionCode?.trim() ?? "";
  if (code && capability.extractionCode.mode !== "custom")
    return "此网盘暂不支持自定义提取码。";
  if (
    code &&
    capability.extractionCode.pattern &&
    !new RegExp(capability.extractionCode.pattern).test(code)
  )
    return capability.extractionCode.description;
  return null;
}
