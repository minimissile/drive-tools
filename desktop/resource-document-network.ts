import type { Provider } from "../shared/types";

/** Signed file addresses come only from the provider API, never from renderer input. */
export function documentDownloadAllowed(provider: Provider, text: string) {
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return false;
    if (provider === "quark")
      return (
        url.hostname.endsWith(".pds.quark.cn") ||
        /^dl-[a-z0-9-]+\.drive\.quark\.cn$/.test(url.hostname)
      );
    if (provider === "uc")
      return (
        url.hostname.endsWith(".pds.uc.cn") ||
        /^dl-[a-z0-9-]+\.drive\.uc\.cn$/.test(url.hostname)
      );
    return false;
  } catch {
    return false;
  }
}
