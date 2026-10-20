import { QuarkProvider } from "./quark";
import type { ProviderTransport } from "./provider";

/** UC uses the clouddrive family with its own session, host and share token flow. */
export class UcProvider extends QuarkProvider {
  constructor(transport: ProviderTransport) {
    super(transport, "uc");
  }
}
