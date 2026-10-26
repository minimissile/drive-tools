import { useLayoutEffect, useRef, type MouseEvent } from "react";

interface WorkbenchPosition {
  scrollTop: number;
  entry: string | null;
}
const positions = new Map<string, WorkbenchPosition>();

/** Keep the launcher position in this session, separately for each workspace. */
export function useWorkbenchPosition(workspace: string) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = root.current?.closest("main");
    const saved = positions.get(workspace);
    if (!scroller || !saved) return;
    scroller.scrollTop = saved.scrollTop;
    const entry = Array.from(
      root.current!.querySelectorAll<HTMLButtonElement>(
        "[data-workbench-entry]",
      ),
    ).find((button) => button.dataset.workbenchEntry === saved.entry);
    entry?.focus({ preventScroll: true });
  }, [workspace]);
  const remember = (event: MouseEvent<HTMLDivElement>) => {
    const scroller = root.current?.closest("main");
    if (!scroller || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button");
    if (!button) return;
    positions.set(workspace, {
      scrollTop: scroller.scrollTop,
      entry: button.dataset.workbenchEntry ?? null,
    });
  };
  return { root, remember };
}
