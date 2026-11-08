export interface DevUpdateState {
  revision: number;
  runningRevision: number;
  pending: boolean;
  compiling: boolean;
  buildError: string;
  applyError: string;
  applying: boolean;
}

export interface DevUpdateContract {
  "dev.updates": { args: undefined; value: DevUpdateState | null };
  "dev.applyUpdates": { args: undefined; value: boolean };
}
