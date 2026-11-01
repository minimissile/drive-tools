import { z } from "zod";
import { useAppData } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";

export function usePublishingView() {
  const { data } = useAppData();
  return useLocalDraft(
    `panxu-zhidao-publish-view:${data!.dataPath}`,
    { tab: "generate" as "generate" | "upload" | "history" },
    (raw) =>
      z.object({ tab: z.enum(["generate", "upload", "history"]) }).parse(raw),
  );
}
