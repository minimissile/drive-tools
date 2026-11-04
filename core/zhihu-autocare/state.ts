import { createHash } from "node:crypto";
import type { ZhihuContent } from "../../shared/zhihu";
import type { Database } from "../database";
import {
  autocareConfigSchema,
  autocareStateSchema,
  type AutocareState,
} from "../../shared/zhihu-autocare";
export const autocareStateKey = "zhihuAutocare:v1";
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const contentFingerprint = (content: ZhihuContent) => {
  const {
    reviewed: _reviewed,
    updatedAt: _updatedAt,
    ...exactVersion
  } = content;
  return fingerprint(exactVersion);
};
export function readAutocareState(db: Database): AutocareState {
  return autocareStateSchema.parse(
    db.setting(autocareStateKey, {
      version: 1,
      config: autocareConfigSchema.parse({}),
      enabled: false,
      revision: 1,
      identities: {},
      model: "",
      jobs: [],
      accountMessages: {},
      message: "选择账号后开启，推荐参数已准备",
      lastHeartbeatAt: null,
      nextCheckAt: null,
    }),
  );
}
export function restoreAutocareState(db: Database, state: AutocareState) {
  db.setSetting(
    autocareStateKey,
    autocareStateSchema.parse({
      ...state,
      enabled: false,
      message: "从备份恢复，自动养号已关闭，开启后重新核对账号与预算",
    }),
  );
}
