import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";

/** Query pages stay in Chromium without showing a native window. Closing a revealed
 * page returns it to the background; owners destroy it when the session ends. */
export function createBackgroundBrowserWindow(
  options: Omit<BrowserWindowConstructorOptions, "show">,
) {
  const window = new BrowserWindow({ ...options, show: false });
  window.on("close", (event) => {
    event.preventDefault();
    window.hide();
  });
  return window;
}
