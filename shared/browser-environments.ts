import { z } from "zod";

export const environmentIdSchema = z.string().regex(/^env_[\w-]{1,100}$/);
export const environmentAccountSchema = z.object({
  kind: z.enum(["website", "zhidao", "binding", "drive"]),
  id: z.string().min(1).max(150),
});
export type EnvironmentAccountRef = z.infer<typeof environmentAccountSchema>;
export const environmentProxySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("direct") }),
  z.object({
    mode: z.enum(["http", "socks5"]),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9.:-]+$/),
    port: z.number().int().min(1).max(65535),
  }),
]);
export type EnvironmentProxy = z.infer<typeof environmentProxySchema>;
export const environmentSaveSchema = z.object({
  id: environmentIdSchema.optional(),
  name: z.string().trim().min(1).max(80),
  engine: z.enum(["electron", "bitbrowser"]),
  profileId: z.string().trim().min(1).max(200).optional(),
  proxy: environmentProxySchema.optional(),
  proxyUsername: z.string().max(300).optional(),
  proxyPassword: z.string().max(1000).optional(),
  clearProxyCredentials: z.boolean().optional(),
  expectedRevision: z.number().int().positive().optional(),
  expectedConnectorKey: z.string().max(300).optional(),
  requireProxy: z.boolean().optional(),
});
export type EnvironmentSaveInput = z.infer<typeof environmentSaveSchema>;
export interface BrowserEnvironment {
  id: string;
  name: string;
  engine: "electron" | "bitbrowser";
  profileId: string;
  revision: number;
  proxy: EnvironmentProxy | null;
  hasProxyCredentials: boolean;
  fingerprint: "native" | "external";
  createdAt: string;
  updatedAt: string;
  connectorKey?: string;
  externalSignature?: string;
  externalProxy?: "direct" | "configured";
  requireProxy?: boolean;
  network?: { ip: string; checkedAt: string; revision: number };
}
export interface EnvironmentStamp {
  environmentId: string;
  revision: number;
  identityId: string;
  identityRevision: number;
}
export interface EnvironmentAccountLink extends EnvironmentAccountRef {
  environmentId: string;
  identityId: string;
  realm: string;
  platform: string;
  alias: string;
  uid: string | null;
  verifiedRevision: number;
}
export interface BrowserEnvironmentView extends BrowserEnvironment {
  accounts: EnvironmentAccountLink[];
  busy: boolean;
}
export interface EnvironmentJob {
  id: string;
  label: string;
  environmentIds: string[];
  accounts: EnvironmentAccountRef[];
  status:
    "queued" | "running" | "completed" | "failed" | "cancelled" | "attention";
  message: string;
  createdAt: string;
  updatedAt: string;
}
/** Privileged port value; never returned by a renderer query. */
export interface BrowserEnvironmentRuntime extends BrowserEnvironment {
  credentials?: { username: string; password: string };
}
type Contract<A, V> = { args: A; value: V };
export interface BrowserEnvironmentContract {
  "environments.list": Contract<undefined, BrowserEnvironmentView[]>;
  "environments.save": Contract<EnvironmentSaveInput, BrowserEnvironment>;
  "environments.bind": Contract<
    EnvironmentAccountRef & { environmentId?: string; confirmed: true },
    BrowserEnvironment
  >;
  "environments.remove": Contract<{ id: string; confirmed: true }, boolean>;
  "environments.open": Contract<{ id: string }, boolean>;
  "environments.checkNetwork": Contract<{ id: string }, BrowserEnvironment>;
  "environments.jobs": Contract<undefined, EnvironmentJob[]>;
  "environments.cancelJob": Contract<{ id: string }, boolean>;
}
