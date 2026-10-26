export interface WeiboEditorPayload {
  environment?: import("./browser-environments").EnvironmentStamp;
  taskId: string;
  uid: string;
  text: string;
  images: { name: string; path: string; sha256: string }[];
  visibility: "public" | "self";
  aiAssisted: boolean;
}
export interface WeiboEditorState {
  environment?: import("./browser-environments").EnvironmentStamp;
  uid: string;
  imageCount: number;
  visibility: "public" | "self";
}
export type WeiboSubmitReceipt =
  | { status: "submitted"; url: string; postId: string }
  | { status: "rejected"; message: string };
