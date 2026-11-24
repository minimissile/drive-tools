import { id, type Database } from "../database";
import { AppError } from "../errors";
import type {
  WechatArticleModule,
  WechatDeleteArticleModuleInput,
  WechatSaveArticleModuleInput,
} from "../../shared/wechat-article-modules";

const key = "wechat:article-modules:v1";
const presets: readonly WechatArticleModule[] = [
  {
    id: "wechat-module-reading-note",
    name: "阅读提示",
    body: "> 建议先浏览全文，了解适用范围，再按需要阅读相关部分。",
    revision: 1,
  },
  {
    id: "wechat-module-usage-note",
    name: "使用说明",
    body: "## 使用说明\n\n使用前请核对适用条件。建议保留原始文件，在副本上操作。",
    revision: 1,
  },
];

function findModule(
  modules: readonly WechatArticleModule[],
  { id, revision }: WechatDeleteArticleModuleInput,
) {
  const index = modules.findIndex((module) => module.id === id);
  if (index < 0)
    throw new AppError("WECHAT_MODULE_NOT_FOUND", "模块已删除，请刷新模块列表。");
  if (revision !== undefined && modules[index].revision !== revision)
    throw new AppError(
      "WECHAT_MODULE_CHANGED",
      "模块已在其他窗口更新，请刷新后重试。",
    );
  return index;
}

export class WechatArticleModules {
  constructor(
    private db: Database,
    private changed: () => void,
  ) {}

  list() {
    // A saved empty list is intentional. Presets are only offered in new workspaces.
    return (
      this.db.setting<WechatArticleModule[] | null>(key, null) ??
      presets.map((module) => ({ ...module }))
    );
  }

  save({ id: moduleId, name, body, revision }: WechatSaveArticleModuleInput) {
    const next = this.db.transaction(() => {
      const modules = this.list();
      if (moduleId) {
        const index = findModule(modules, { id: moduleId, revision });
        modules[index] = {
          id: moduleId,
          name,
          body,
          revision: modules[index].revision + 1,
        };
      } else {
        modules.push({ id: id("wechat_module"), name, body, revision: 1 });
      }
      this.db.setSetting(key, modules);
      return modules;
    });
    this.changed();
    return next;
  }

  delete(input: WechatDeleteArticleModuleInput) {
    const next = this.db.transaction(() => {
      const modules = this.list();
      modules.splice(findModule(modules, input), 1);
      this.db.setSetting(key, modules);
      return modules;
    });
    this.changed();
    return next;
  }
}
