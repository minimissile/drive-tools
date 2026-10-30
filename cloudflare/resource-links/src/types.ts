/** This deployable service intentionally has no dependency on the desktop app. */
export const providers = [
  "quark",
  "baidu",
  "uc",
  "xunlei",
  "guangya",
  "pikpak",
] as const;
export type Provider = (typeof providers)[number];

export interface LinkWrite {
  operationId: string;
  expectedRevision: number;
  slug: string;
  title: string;
  provider: Provider;
  targetUrl: string | null;
  code: string;
  enabled: boolean;
}

export interface RemoteLink {
  id: string;
  slug: string;
  url: string;
  title: string;
  provider: Provider;
  targetUrl: string | null;
  code: string;
  enabled: boolean;
  revision: number;
  lastOperationId: string;
  updatedAt: string;
}

/** Bindings and runtime APIs come from `wrangler types`, never a parallel hand-written shape. */
export type Env = Cloudflare.Env;

export interface LinkRow {
  id: string;
  slug: string;
  title: string;
  provider: Provider;
  target_url: string | null;
  code: string;
  enabled: number;
  revision: number;
  last_operation_id: string;
  updated_at: string;
}

export interface OperationRow extends LinkRow {
  request_json: string;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
