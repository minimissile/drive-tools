import type { BrowserBinding } from "./types";
import {
  hasCurrentPermission,
  channelProfiles,
  type ContentFormat,
  type LinkPosition,
  type Platform,
} from "./channels";
import { platformSpecs } from "./platforms";
export function canUseLinkPosition(
  platform: Platform,
  binding: BrowserBinding | null | undefined,
  format: ContentFormat,
  position: LinkPosition,
): boolean {
  return (
    !!binding &&
    binding.platform === platform &&
    channelProfiles[platform].positions.includes(position) &&
    (platformSpecs.find((p) => p.id === platform)?.linkMode !== "blocked" ||
      position === "component") &&
    hasCurrentPermission(binding, format, position)
  );
}
/** Checks the actual URL, so a source share or a longer share ID cannot satisfy the delivery check. */
export function includesOwnShareLink(
  body: string,
  ownUrl: string | null | undefined,
): boolean {
  if (!ownUrl) return false;
  let own: URL;
  try {
    own = new URL(ownUrl);
  } catch {
    return false;
  }
  const prose = body
    .replace(/<!--[^]*?-->/g, "")
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  return (prose.match(/https?:\/\/[^\s<>"'，。；）)]+/gi) ?? []).some(
    (candidate) => {
      try {
        const url = new URL(candidate);
        return (
          !url.username &&
          !url.password &&
          url.origin === own.origin &&
          url.pathname.replace(/\/$/, "") === own.pathname.replace(/\/$/, "")
        );
      } catch {
        return false;
      }
    },
  );
}
