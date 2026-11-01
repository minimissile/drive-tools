import { useEffect } from "react";
import { useAppNavigation } from "../state";
import { LoadingState } from "../ui/primitives";
import { usePublishingView } from "./usePublishingView";

/** Preserve saved routes and old shortcuts while using the unified workbench. */
export default function Templates() {
  const { navigate } = useAppNavigation();
  const { update } = usePublishingView();
  useEffect(() => {
    update({ tab: "generate" });
    navigate("zhidao-publish");
  }, [navigate, update]);
  return <LoadingState compact label="正在打开问答发布…" />;
}
