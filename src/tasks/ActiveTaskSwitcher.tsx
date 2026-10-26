import { useIpcQuery } from "../api/useIpcQuery";
import { useAppData, useAppNavigation } from "../state";
import { Select } from "../ui/Select";
import { Button } from "../ui/primitives";
import { useTaskFocus } from "./TaskFocus";
import { activeTaskOptions } from "./active-task-options";

export function ActiveTaskSwitcher() {
  const { data } = useAppData();
  const { navigate } = useAppNavigation();
  const { request } = useTaskFocus();
  const runs = useIpcQuery("zhidao.activeRuns", undefined, {
    enabled: !!data,
    keepPrevious: true,
    refreshInterval: 2000,
  });
  const options = activeTaskOptions(runs.data ?? [], data?.jobs ?? []);
  const label =
    runs.loading && !runs.data
      ? "正在读取任务…"
      : runs.error
        ? "任务读取失败"
        : options.length
          ? `进行中任务（${options.length}）`
          : "暂无进行中任务";
  return (
    <div className="active-task-switcher">
      <Select
        aria-label="查看进行中任务"
        value=""
        className="active-task-select"
        disabled={!options.length}
        items={[{ value: "", label, disabled: true }, ...options]}
        onValueChange={(value) => {
          const task = options.find((option) => option.value === value);
          if (!task) return;
          request(task.focus);
          navigate(task.page);
        }}
      />
      {runs.error ? (
        <Button
          quiet
          size="compact"
          onClick={runs.reload}
          aria-label="重新读取进行中任务"
        >
          重试
        </Button>
      ) : null}
    </div>
  );
}
