import { createRoot } from "react-dom/client";
import type {
  AppProvider,
  useAppData,
  useAppNavigation,
  useAppActions,
} from "../src/state";

/** Render a provider from one Vite generation with consumers from the next. */
export function mountContextProbe(
  Provider: typeof AppProvider,
  hooks: {
    useAppData: typeof useAppData;
    useAppNavigation: typeof useAppNavigation;
    useAppActions: typeof useAppActions;
  },
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Probe() {
    const { data } = hooks.useAppData();
    const navigation = hooks.useAppNavigation();
    const actions = hooks.useAppActions();
    return (
      <output
        data-testid="context-generation-probe"
        data-navigation={navigation.page}
        data-command={typeof actions.command}
      >
        {data?.dataPath ?? "waiting"}
      </output>
    );
  }
  root.render(
    <Provider>
      <Probe />
    </Provider>,
  );
  return () => {
    root.unmount();
    host.remove();
  };
}
