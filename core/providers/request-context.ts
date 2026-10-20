import type { Provider } from "../../shared/types";
import { providerSpecs } from "../../shared/providers";

/** Match the browser's strict-origin-when-cross-origin referrer behavior.
 * Electron rejects a cross-origin request with an unsanitized path in Referer.
 */
export function providerRequestReferer(
  provider: Provider,
  destination: URL,
): string {
  const home = new URL(providerSpecs[provider].home);
  return destination.origin === home.origin ? home.href : `${home.origin}/`;
}
