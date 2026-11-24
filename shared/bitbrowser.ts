import { z } from "zod";
import type { EnvironmentAccountRef } from "./browser-environments";

export const bitProfileCommandSchema = z.object({
  profileId: z.string().trim().min(1).max(200),
  connectorKey: z.string().min(1).max(300),
});
export type BitProfileCommand = z.infer<typeof bitProfileCommandSchema>;
export interface BitBrowserProfile {
  id: string;
  name: string;
  seq: number | null;
  groupId: string;
  groupName: string;
  remark: string;
}
export interface BitBrowserWindow extends BitBrowserProfile {
  running: boolean | null;
}
export interface BitBrowserWindows {
  connectorKey: string;
  checkedAt: string;
  statusError: string;
  windows: BitBrowserWindow[];
}
export interface BitProfileConfiguration {
  proxyType: string;
  proxyHost: string;
  proxyPort: string;
  dynamicIp: boolean;
  stopWhileNetError: boolean;
  randomFingerprint: boolean;
  os: string;
  coreVersion: string;
}
export interface BitBrowserAccountState extends EnvironmentAccountRef {
  alias: string;
  platform: string;
  uid: string | null;
  status: "verified" | "unverified" | "expired";
  message: string;
}
export interface BitBrowserDiagnostic {
  checkedAt: string;
  configuration: BitProfileConfiguration | null;
  configurationError: string;
  accounts: BitBrowserAccountState[];
  blockers: string[];
  pendingOperations: string[];
}
export const bitIdlePolicySchema = bitProfileCommandSchema.extend({
  idleMinutes: z.union([
    z.literal(0),
    z.literal(10),
    z.literal(30),
    z.literal(60),
  ]),
});
export interface BitPageStatus {
  temporary: number;
  protected: number;
  closed: number;
  connected: boolean;
  owner: "panxu" | "retained";
  busy: boolean;
  lastUsed: number | null;
  idleMinutes: number;
}
type Contract<A, V> = { args: A; value: V };
export interface BitBrowserContract {
  "bit.pages": Contract<BitProfileCommand, BitPageStatus>;
  "bit.cleanPages": Contract<BitProfileCommand, BitPageStatus>;
  "bit.idlePolicy": Contract<z.infer<typeof bitIdlePolicySchema>, boolean>;
  "bit.profiles": Contract<undefined, BitBrowserWindows>;
  "bit.diagnose": Contract<BitProfileCommand, BitBrowserDiagnostic>;
  "bit.openProfile": Contract<BitProfileCommand, boolean>;
  "bit.closeProfile": Contract<
    BitProfileCommand & { confirmed: true; expectedRevision?: number },
    boolean
  >;
  "bit.openAccount": Contract<
    BitProfileCommand & { account: EnvironmentAccountRef },
    boolean
  >;
}
