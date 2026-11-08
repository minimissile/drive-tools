import { z } from "zod";
import type { WebsiteAccount } from "./website-accounts";
import type { VideoJob } from "./video-jobs";

export const bilibiliKinds = {
  video: "视频投稿",
  dynamic: "图文动态",
  article: "专栏文章",
} as const;
export type BilibiliKind = keyof typeof bilibiliKinds;
export const bilibiliDraftId = z.string().regex(/^bili_[\w-]{1,80}$/);
export const bilibiliDraftInput = z.object({
  id: bilibiliDraftId.optional(),
  revision: z.number().int().positive().optional(),
  accountId: z.string().max(100).default(""),
  copyId: z.string().max(100).default(""),
  kind: z.enum(["video", "dynamic", "article"]).default("video"),
  title: z.string().trim().min(1, "请填写稿件标题。").max(80),
  text: z.string().max(100000).default(""),
  tags: z.array(z.string().trim().min(1).max(20)).max(10).default([]),
  videoJobId: z.string().max(100).default(""),
});
export type BilibiliDraftInput = z.input<typeof bilibiliDraftInput>;
export interface BilibiliPreparation {
  status: "filled" | "partial";
  editorUrl: string;
  filledFields: string[];
  mediaSelected: boolean;
  imageSelected: boolean;
  message: string;
  preparedAt: string;
}
export interface BilibiliDraft extends z.output<typeof bilibiliDraftInput> {
  id: string;
  revision: number;
  stage: "draft" | "prepared" | "attention";
  createdAt: string;
  updatedAt: string;
  message: string;
  preparation?: BilibiliPreparation;
  receipt?: { url: string; status: "unverified"; recordedAt: string };
}
export type BilibiliDraftSummary = Pick<
  BilibiliDraft,
  | "id"
  | "revision"
  | "accountId"
  | "copyId"
  | "kind"
  | "title"
  | "videoJobId"
  | "stage"
  | "updatedAt"
  | "message"
  | "receipt"
>;
export interface BilibiliPreview {
  draft: BilibiliDraft;
  accountLabel: string;
  editorUrl: string;
  video: VideoJob | null;
  imageUrl: string | null;
  issues: { level: "error" | "warning"; message: string }[];
}
/** Paths are resolved by the backend from associated, completed local assets. */
export interface BilibiliEditorPayload {
  draftId: string;
  uid: string;
  kind: BilibiliKind;
  title: string;
  text: string;
  tags: string[];
  videoPath?: string;
  coverPath?: string;
}
export interface BilibiliContentPort {
  prepare(
    account: WebsiteAccount,
    payload: BilibiliEditorPayload,
  ): Promise<Omit<BilibiliPreparation, "preparedAt">>;
  isOpen?(): boolean;
  close?(): void;
}
type Contract<A, V> = { args: A; value: V };
export interface BilibiliContract {
  "bilibili.list": Contract<undefined, BilibiliDraftSummary[]>;
  "bilibili.get": Contract<{ id: string }, BilibiliDraft>;
  "bilibili.save": Contract<BilibiliDraftInput, BilibiliDraft>;
  "bilibili.preview": Contract<{ id: string }, BilibiliPreview>;
  "bilibili.prepare": Contract<{ id: string }, BilibiliDraft>;
  "bilibili.export": Contract<{ id: string }, string | null>;
  "bilibili.recordReceipt": Contract<
    { id: string; url: string },
    BilibiliDraft
  >;
}

export function bilibiliEditorUrl(kind: BilibiliKind) {
  return kind === "video"
    ? "https://member.bilibili.com/platform/upload/video/frame"
    : kind === "article"
      ? "https://member.bilibili.com/york/read-editor"
      : "https://t.bilibili.com/";
}

/** Only final official content URLs, never a tracking short link or a claimed success. */
export function canonicalBilibiliReceipt(raw: string, kind: BilibiliKind) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new Error("请填写哔哩哔哩官网的完整内容链接。");
  const video = url.pathname.match(
    /^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10})\/?$/,
  );
  if (
    kind === "video" &&
    ["www.bilibili.com", "bilibili.com"].includes(url.hostname) &&
    video
  )
    return `https://www.bilibili.com/video/${video[1]}/`;
  const opus = url.pathname.match(/^\/opus\/([1-9]\d{0,29})\/?$/);
  if (
    kind !== "video" &&
    ["www.bilibili.com", "bilibili.com"].includes(url.hostname) &&
    opus
  )
    return `https://www.bilibili.com/opus/${opus[1]}`;
  const dynamic = url.pathname.match(/^\/([1-9]\d{0,29})\/?$/);
  if (kind === "dynamic" && url.hostname === "t.bilibili.com" && dynamic)
    return `https://t.bilibili.com/${dynamic[1]}`;
  const article = url.pathname.match(/^\/read\/cv([1-9]\d{0,19})\/?$/);
  if (
    kind === "article" &&
    ["www.bilibili.com", "bilibili.com"].includes(url.hostname) &&
    article
  )
    return `https://www.bilibili.com/read/cv${article[1]}`;
  throw new Error(
    "链接与稿件类型不匹配，请填写官网视频、动态或专栏详情页链接。",
  );
}
