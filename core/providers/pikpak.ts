import { TokenDriveProvider } from "./token-drive";
import type { ProviderTransport } from "./provider";
/** Compatibility adapter for the first-party web protocol, not a public OpenAPI. */
export class PikPakProvider extends TokenDriveProvider {
  constructor(transport: ProviderTransport) {
    super(transport, "pikpak");
  }
}
