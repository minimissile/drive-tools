import { z } from "zod";
import type { CollectionDriveType } from "./resource-collection";

export function zhidaoAnswerPageUrl(raw: string) {
  try {
    const u = new URL(raw, "https://zhidao.baidu.com");
    const match = u.pathname.match(
      /^\/question\/(\d+)(?:\/answer\/(\d+))?\.html$/,
    );
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.hostname !== "zhidao.baidu.com" ||
      u.username ||
      u.password ||
      u.port ||
      !match
    )
      return null;
    return {
      url: `https://zhidao.baidu.com${u.pathname}`,
      qid: match[1],
      aid: match[2] || "",
    };
  } catch {
    return null;
  }
}
export const pageDiscoveryInput = z
  .object({
    keywords: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    urls: z
      .array(
        z
          .string()
          .trim()
          .max(2000)
          .refine(
            (v) => !!zhidaoAnswerPageUrl(v),
            "请填写百度知道问题页或回答页地址",
          ),
      )
      .max(100)
      .default([]),
    pages: z.number().int().min(1).max(5).default(2),
    limit: z.number().int().min(1).max(200).default(50),
    intervalMs: z.number().int().min(1000).max(10000).default(2000),
  })
  .refine(
    (v) => v.keywords.length + v.urls.length > 0,
    "请填写关键词或待检查页面",
  );
export type PageDiscoveryInput = z.infer<typeof pageDiscoveryInput>;
export interface DiscoveredAnswer {
  id: string;
  qid: string;
  aid: string;
  title: string;
  questionUrl: string;
  answerUrl: string;
  answer: string;
  keyword: string;
  origin: "search" | "specified";
  foundAt: string;
  links: { url: string; code: string; provider: CollectionDriveType }[];
}
export interface DiscoveryPageJob {
  kind: "search" | "detail";
  url: string;
  keyword: string;
  origin: "search" | "specified";
}
export interface PageDiscoveryRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "paused" | "completed";
  input: PageDiscoveryInput;
  jobs: DiscoveryPageJob[];
  cursor: number;
  checked: number;
  searchPages: number;
  failed: number;
  noLinks: number;
  items: DiscoveredAnswer[];
  logs: {
    at: string;
    kind: "info" | "success" | "warning";
    message: string;
    url?: string;
  }[];
  message: string;
}
export interface PageDiscoveryPort {
  read(
    url: string,
    signal: AbortSignal,
  ): Promise<{ body: string; url: string }>;
  open(url?: string): Promise<void>;
  isOpen(): boolean;
  close(): void;
}
type Contract<A, V> = { args: A; value: V };
export interface PageDiscoveryContract {
  "zhidaoPages.latest": Contract<undefined, PageDiscoveryRun | null>;
  "zhidaoPages.start": Contract<PageDiscoveryInput, PageDiscoveryRun>;
  "zhidaoPages.pause": Contract<{ id: string }, PageDiscoveryRun>;
  "zhidaoPages.resume": Contract<{ id: string }, PageDiscoveryRun>;
  "zhidaoPages.browser": Contract<undefined, void>;
  "zhidaoPages.export": Contract<
    { id: string; format: "json" | "csv" },
    string | null
  >;
}
