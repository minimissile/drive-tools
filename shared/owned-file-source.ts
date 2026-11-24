import { providerIds, providerSpecs } from "./providers";
import type { Provider } from "./types";

/** Internal provenance for an indexed owned object. It is never a delivery share. */
export function ownedFileSource(
  provider: Provider,
  accountId: string,
  uid: string,
  fileId: string,
) {
  return (
    providerSpecs[provider].home +
    "#panxu-owned=" +
    encodeURIComponent(`${accountId}:${uid}:${fileId}`)
  );
}
export function isIndexedOwnSource(text: string) {
  try {
    const url = new URL(text);
    return (
      !!url.hash.slice("#panxu-owned=".length) &&
      url.hash.startsWith("#panxu-owned=") &&
      !url.username &&
      !url.password &&
      providerIds.some((p) => {
        const home = new URL(providerSpecs[p].home);
        return (
          url.origin === home.origin &&
          url.pathname === home.pathname &&
          url.search === home.search
        );
      })
    );
  } catch {
    return false;
  }
}
