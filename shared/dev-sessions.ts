import { z } from "zod";

export const devSessionModeSchema = z.enum(["development", "automation"]);
export const devSessionStatusSchema = z.enum([
  "idle",
  "running",
  "paused",
  "passed",
  "failed",
  "interrupted",
]);
const label = z.string().trim().max(80);
export const openDevSessionSchema = z.object({
  label: label.min(1),
  session: label.default(""),
  mode: devSessionModeSchema.default("development"),
  initialPage: z
    .string()
    .regex(/^[a-z][a-z-]*$/)
    .max(60)
    .optional(),
});
export const updateDevSessionSchema = z.object({
  id: z.string().min(1).max(80),
  label: label.min(1).optional(),
  session: label.optional(),
  status: devSessionStatusSchema.optional(),
  expectedStatus: devSessionStatusSchema.optional(),
});
export const devSessionIdSchema = z.object({ id: z.string().min(1).max(80) });
export type OpenDevSession = z.input<typeof openDevSessionSchema>;
export type UpdateDevSession = z.infer<typeof updateDevSessionSchema>;
export interface DevSession {
  id: string;
  label: string;
  session: string;
  mode: z.infer<typeof devSessionModeSchema>;
  status: z.infer<typeof devSessionStatusSchema>;
  initialPage?: string;
  createdAt: string;
}
export const devSessionStatusLabels: Record<DevSession["status"], string> = {
  idle: "开发中",
  running: "自动化测试中",
  paused: "测试已暂停",
  passed: "测试通过",
  failed: "测试失败",
  interrupted: "已手动接管",
};
export function devSessionTitle(info: DevSession) {
  const state =
    info.mode === "development"
      ? "开发中"
      : devSessionStatusLabels[info.status];
  return ["盘序", state, info.label, info.session].filter(Boolean).join(" · ");
}
export interface DevSessionContract {
  "dev.session": { args: undefined; value: DevSession };
  "dev.sessions": { args: undefined; value: DevSession[] };
  "dev.session.open": { args: OpenDevSession; value: DevSession };
  "dev.session.update": { args: UpdateDevSession; value: DevSession };
  "dev.session.close": { args: { id: string }; value: boolean };
  "dev.session.focus": { args: { id: string }; value: boolean };
}
