import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
} from "electron";

let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});

/** Query pages stay in Chromium without showing a native window. Closing a revealed
 * page returns it to the background; owners destroy it when the session ends. */
export function createBackgroundBrowserWindow(
  options: Omit<BrowserWindowConstructorOptions, "show">,
) {
  const window = new BrowserWindow({ ...options, show: false });
  window.on("close", (event) => {
    // A normal application shutdown must release query pages as well. Otherwise
    // a dev restart closes every workbench but remains stuck on a hidden page.
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  return window;
}
