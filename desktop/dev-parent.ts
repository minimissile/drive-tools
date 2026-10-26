/** Desktop development belongs to its supervisor, including unexpected parent exit. */
export function watchDevParent(
  parent: Pick<NodeJS.Process, "send" | "connected" | "once">,
  quit: () => void,
) {
  if (!parent.send) return;
  if (!parent.connected) quit();
  else parent.once("disconnect", quit);
}
