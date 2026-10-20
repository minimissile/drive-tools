import { useIpcQuery } from "../api/useIpcQuery";
import { editorValueForDraft } from "../../shared/studio";
import type { Draft } from "../../shared/types";

/** A saved version cannot be delivered while another editor value is still staged. */
export function useDraftDeliveryStatus(draft: Draft | undefined) {
  const {
    data: working,
    loading,
    error,
  } = useIpcQuery(
    "studio.workingCopy",
    { draftId: draft?.id ?? "" },
    { enabled: !!draft, revision: draft?.updatedAt },
  );
  const blocked =
    !draft ||
    loading ||
    !!error ||
    (!!working &&
      JSON.stringify(working.value) !==
        JSON.stringify(editorValueForDraft(draft)));
  return { blocked, loading, error };
}
