import { TokenDriveProvider } from "./token-drive";
import type { ProviderTransport } from "./provider";
export class XunleiProvider extends TokenDriveProvider {
  constructor(transport: ProviderTransport) {
    super(transport, "xunlei");
  }
}
