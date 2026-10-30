import type { Provider } from "./types";

export interface ResourceLinkSettings {
  enabled: boolean;
  baseUrl: string;
  configured: boolean;
  maskedToken: string;
}

export interface ResourceLink {
  id: string;
  resourceId: string;
  slug: string;
  url: string;
  state: "pending" | "synced" | "error";
  enabled: boolean;
  targetUrl: string | null;
  code: string;
  revision: number;
  updatedAt: string;
  syncedAt: string | null;
  error: string | null;
  hasPendingOperation: boolean;
  requestMissing?: boolean;
}

export interface ResourceLinkContext {
  settings: ResourceLinkSettings;
  link: ResourceLink | null;
  currentCopyId: string | null;
  currentShareUrl: string | null;
  currentTargetIssue: string | null;
}

export interface RemoteResourceLink {
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

export interface ResourceLinkWrite {
  operationId: string;
  expectedRevision: number;
  slug: string;
  title: string;
  provider: Provider;
  targetUrl: string | null;
  code: string;
  enabled: boolean;
}

export interface ResourceLinksContract {
  "resourceLinks.settings": { args: undefined; value: ResourceLinkSettings };
  "resourceLinks.configure": {
    args: { enabled: boolean; baseUrl: string; token?: string };
    value: ResourceLinkSettings;
  };
  "resourceLinks.checkConnection": {
    args: undefined;
    value: { message: string };
  };
  "resourceLinks.get": {
    args: { resourceId: string };
    value: ResourceLinkContext;
  };
  "resourceLinks.ensure": {
    args: { resourceId: string };
    value: ResourceLinkContext;
  };
  "resourceLinks.useCurrent": {
    args: { resourceId: string };
    value: ResourceLinkContext;
  };
  "resourceLinks.setTarget": {
    args: { resourceId: string; text: string; code?: string };
    value: ResourceLinkContext;
  };
  "resourceLinks.setEnabled": {
    args: { resourceId: string; enabled: boolean };
    value: ResourceLinkContext;
  };
  "resourceLinks.retry": {
    args: { resourceId: string };
    value: ResourceLinkContext;
  };
  "resourceLinks.refresh": {
    args: { resourceId: string };
    value: ResourceLinkContext;
  };
  "resourceLinks.recover": {
    args: { resourceId: string };
    value: ResourceLinkContext;
  };
  "resourceLinks.copy": {
    args: { resourceId: string };
    value: { text: string };
  };
}
