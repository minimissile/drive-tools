import { z } from "zod";

export const runtimeLogQuery = z.object({
  page: z.number().int().min(1).max(100000).default(1),
  accountId: z.string().max(150).default(""),
  level: z.enum(["all", "info", "warning", "error", "issues"]).default("all"),
  search: z.string().trim().max(200).default(""),
  excludeHeartbeats: z.boolean().default(false),
});
export interface RuntimeLogEntry {
  id: number;
  domain: string;
  level: "info" | "warning" | "error";
  event: string;
  message: string;
  accountId: string | null;
  taskId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}
export interface RuntimeLogPage {
  items: RuntimeLogEntry[];
  total: number;
  page: number;
  pageSize: number;
  folder: string;
}
