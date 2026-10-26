// A one-time, workspace-scoped navigation handoff. It carries a selection only.
const pending = new Map<string, string>();
export function prepareEnvironmentAccounts(
  workspace: string,
  environmentId: string,
) {
  pending.set(workspace, environmentId);
}
export function readAccountEnvironment(workspace: string) {
  return pending.get(workspace) ?? "";
}
export function clearAccountEnvironment(
  workspace: string,
  environmentId: string,
) {
  if (pending.get(workspace) === environmentId) pending.delete(workspace);
}
