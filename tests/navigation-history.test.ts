import test from "node:test";
import assert from "node:assert/strict";
import {
  navigationHistory,
  parseNavigationHistory,
  type NavigationHistory,
  type NavigationRoute,
} from "../src/state/navigation-history";

const route: NavigationRoute = {
  page: "wechat-workflow",
  resourceId: "resource-a",
  copyId: "copy-a",
  editResourceId: null,
  editCopyId: null,
  settingsSection: "ai",
  searchFocus: null,
};
const initial: NavigationHistory = {
  current: route,
  past: [],
  workspace: "/workspace/a",
};

test("返回记录按实际访问顺序弹出，重复页面不记录，返回后新导航不会回到被弹出的页面", () => {
  const accounts = navigationHistory(initial, {
    type: "navigate",
    patch: { page: "wechat-accounts" },
  });
  assert.strictEqual(
    navigationHistory(accounts, {
      type: "navigate",
      patch: { page: "wechat-accounts" },
    }),
    accounts,
  );
  const settings = navigationHistory(accounts, {
    type: "navigate",
    patch: { page: "settings", settingsSection: "browser" },
  });
  const back = navigationHistory(settings, { type: "back" });
  assert.equal(back.current.page, "wechat-accounts");
  assert.deepEqual(back.past, [route]);
  const next = navigationHistory(back, {
    type: "navigate",
    patch: { page: "library" },
  });
  assert.equal(
    navigationHistory(next, { type: "back" }).current.page,
    "wechat-accounts",
  );
  const empty = navigationHistory(navigationHistory(next, { type: "back" }), {
    type: "back",
  });
  assert.equal(empty.current.page, "wechat-workflow");
  assert.strictEqual(navigationHistory(empty, { type: "back" }), empty);
});

test("返回恢复资源、编辑对象及搜索定位，同页不同对象也能返回", () => {
  const editing = navigationHistory(initial, {
    type: "navigate",
    patch: { page: "intake", editResourceId: "a", editCopyId: "copy-a" },
  });
  const another = navigationHistory(editing, {
    type: "navigate",
    patch: {
      resourceId: "b",
      copyId: "copy-b",
      editResourceId: "b",
      editCopyId: "copy-b",
    },
  });
  assert.deepEqual(
    navigationHistory(another, { type: "back" }).current,
    editing.current,
  );
  const search = navigationHistory(another, {
    type: "navigate",
    patch: {
      page: "search",
      searchFocus: { copyId: "copy-b", topicId: "topic-a" },
    },
  });
  const settings = navigationHistory(search, {
    type: "navigate",
    patch: { page: "settings", settingsSection: "sources" },
  });
  assert.deepEqual(
    navigationHistory(settings, { type: "back" }).current,
    search.current,
  );
  assert.strictEqual(
    navigationHistory(search, {
      type: "navigate",
      patch: {
        page: "search",
        searchFocus: { topicId: "topic-a", copyId: "copy-b" },
      },
    }),
    search,
  );
  const selection = navigationHistory(search, {
    type: "update",
    patch: { resourceId: "c" },
  });
  assert.strictEqual(selection.past, search.past);
});

test("记录可以恢复，损坏数据被忽略，跨工作空间清空历史且有长度上限", () => {
  let state = initial;
  for (let i = 0; i < 50; i++) {
    state = navigationHistory(state, {
      type: "navigate",
      patch: { page: i % 2 ? "accounts" : "settings" },
    });
  }
  assert.equal(state.past.length, 40);
  assert.deepEqual(
    parseNavigationHistory(JSON.parse(JSON.stringify(state)), [
      "wechat-workflow",
      "accounts",
      "settings",
    ]),
    state,
  );
  assert.equal(
    parseNavigationHistory(
      { ...state, current: { ...route, page: "unknown" } },
      ["wechat-workflow"],
    ),
    undefined,
  );
  assert.equal(
    parseNavigationHistory(
      { ...state, past: [{ ...route, searchFocus: { topicId: 123 } }] },
      ["wechat-workflow", "accounts", "settings"],
    ),
    undefined,
  );
  const reset = navigationHistory(state, {
    type: "workspace",
    path: "/workspace/b",
  });
  assert.deepEqual(reset.past, []);
  assert.strictEqual(reset.current, state.current);
  assert.strictEqual(
    navigationHistory(reset, { type: "workspace", path: "/workspace/b" }),
    reset,
  );
});
