import React from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "./App";
import { AppProvider } from "./state";
import { UpdatesProvider } from "./updates-state";
import "./styles.css";
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="launch-error">
        <h1>界面暂时无法打开</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
// Entry modules can run again when Fast Refresh invalidates a dependency.
// Keep one owner of the container so old and new React trees cannot coexist.
const container = document.getElementById("root")! as HTMLElement & {
  __panxuReactRoot?: Root;
  __panxuEntryRevision?: number;
};
const root = (container.__panxuReactRoot ??= createRoot(container));
// An invalidated entry gets a fresh boundary instead of retaining an HMR error.
const entryRevision = import.meta.hot
  ? (container.__panxuEntryRevision = (container.__panxuEntryRevision ?? 0) + 1)
  : 0;
root.render(
  <React.StrictMode>
    <ErrorBoundary key={entryRevision}>
      <AppProvider>
        <UpdatesProvider>
          <App />
        </UpdatesProvider>
      </AppProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
