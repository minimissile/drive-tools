import test from "node:test";
import assert from "node:assert/strict";
import { existingBitBrowserDirectory } from "../core/bitbrowser-existing";
test("比特存活配置恢复：仅匹配指定配置的主进程目录", () => {
  const id = "fc7138eb077d4244b9650e05dae14c21";
  const directory = `/Users/example/Library/Application Support/BitBrowser/BrowserCache/${id}`;
  const command = `/Users/example/BitBrowser.app/Contents/MacOS/BitBrowser --remote-debugging-port=0 --user-data-dir=${directory} about:blank`;
  assert.equal(existingBitBrowserDirectory(command, id), directory);
  assert.equal(
    existingBitBrowserDirectory(command, "3e27b6e122fc474e805d9c8d8ac8939c"),
    null,
  );
  assert.equal(
    existingBitBrowserDirectory(command + " --type=renderer", id),
    null,
  );
  assert.equal(
    existingBitBrowserDirectory(
      command.replace(directory, directory + "-old"),
      id,
    ),
    null,
  );
  assert.equal(
    existingBitBrowserDirectory(command.replace("BrowserCache/", "Other/"), id),
    null,
  );
  assert.equal(
    existingBitBrowserDirectory(
      command.replace(
        "BitBrowser.app/Contents/MacOS/BitBrowser",
        "Other.app/Contents/MacOS/Other",
      ),
      id,
    ),
    null,
  );
});
