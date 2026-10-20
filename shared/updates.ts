export type UpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";
export interface UpdatePreferences {
  autoCheck: boolean;
  skippedVersion: string | null;
  lastCheckedAt: string | null;
}
export interface UpdateRelease {
  version: string;
  notes: string;
  date: string | null;
}
export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}
export interface UpdateState extends UpdatePreferences {
  revision: number;
  phase: UpdatePhase;
  currentVersion: string;
  platform: string;
  arch: string;
  repository: string | null;
  canInstall: boolean;
  reason: string | null;
  release: UpdateRelease | null;
  progress: UpdateProgress | null;
  cancelRequested: boolean;
  error: {
    code: string;
    message: string;
    retry: "check" | "download" | "install";
  } | null;
}
