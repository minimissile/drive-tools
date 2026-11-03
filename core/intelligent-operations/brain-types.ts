import type {
  IntelligentOperationsDependencies,
  OperationsChannelPolicy,
} from "./types";
import type { IntelligentOperationsState } from "./state";
import type {
  OperationsPlan,
  OperationsTask,
} from "../../shared/intelligent-operations";
import type {
  OperationsBrainCycle,
  OperationsBrainPermissions,
} from "../../shared/operations-brain";

export interface OperationsBrainHost {
  d: IntelligentOperationsDependencies;
  state(): IntelligentOperationsState;
  plan(id: string): OperationsPlan;
  running(): boolean;
  closed(): boolean;
  now(): number;
  persist(): void;
  saveTask(task: OperationsTask): OperationsTask;
  accountPolicy(
    plan: OperationsPlan,
    accountId: string,
  ): OperationsChannelPolicy;
  baseReason(
    plan: OperationsPlan,
    accountId: string,
    kind: OperationsTask["kind"],
  ): string | null;
  publicationSlot(
    task: OperationsTask,
    plan: OperationsPlan,
    startAt?: number,
    includeReservations?: boolean,
  ): string | null;
  execute(task: OperationsTask): Promise<void>;
  stopOwned(planId: string): void;
  log(
    event: string,
    message: string,
    planId: string,
    details?: Record<string, unknown>,
    level?: "info" | "warning" | "error",
  ): void;
}
export interface OperationsBrainToolContext {
  host: OperationsBrainHost;
  plan: OperationsPlan;
  cycle: OperationsBrainCycle;
  permissions: OperationsBrainPermissions;
  guard(permission?: keyof OperationsBrainPermissions): void;
  toolCallId: string;
}
