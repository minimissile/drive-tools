import { useEffect, useState } from "react";
import { exportInput, type ExportInput } from "../../shared/resource-export";
type EditorInput = Omit<ExportInput, "images"> & {
  images: { name: string; data: string }[];
  missingImages: number;
  planError: string;
};
const editorMemory = new Map<string, EditorInput>();
function savedEditor(key: string): EditorInput | null {
  if (editorMemory.has(key)) return editorMemory.get(key)!;
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null");
    const parsed = exportInput.safeParse(raw ? { ...raw, images: [] } : null);
    return parsed.success
      ? {
          ...parsed.data,
          images: [],
          missingImages: Math.min(3, Number(raw.missingImages) || 0),
          planError: typeof raw.planError === "string" ? raw.planError : "",
        }
      : null;
  } catch {
    return null;
  }
}

export function useExportInput(dataPath: string) {
  const editorKey = `panxu-resource-export-editor-v1:${dataPath}`;
  const [initialEditor] = useState(() => savedEditor(editorKey));
  const [request, setRequest] = useState(initialEditor?.request ?? ""),
    [images, setImages] = useState<{ name: string; data: string }[]>(
      initialEditor?.images ?? [],
    );
  const [missingImages, setMissingImages] = useState(
      initialEditor?.missingImages ?? 0,
    ),
    [planError, setPlanError] = useState(initialEditor?.planError ?? "");
  const [scope, setScope] = useState<ExportInput["scope"]>(
      initialEditor?.scope ?? "combined",
    ),
    [category, setCategory] = useState(initialEditor?.category ?? "all"),
    [provider, setProvider] = useState<ExportInput["provider"]>(
      initialEditor?.provider ?? "all",
    ),
    [accountId, setAccountId] = useState(initialEditor?.accountId ?? "all"),
    [archivedOnly, setArchivedOnly] = useState(
      initialEditor?.archivedOnly ?? false,
    );
  useEffect(() => {
    const value = {
      request,
      images,
      scope,
      category,
      provider,
      accountId,
      archivedOnly,
      missingImages,
      planError,
    };
    editorMemory.set(editorKey, value);
    try {
      localStorage.setItem(
        editorKey,
        JSON.stringify({
          ...value,
          images: [],
          missingImages: images.length || missingImages,
        }),
      );
    } catch {
      /* Keep the active session in memory. */
    }
  }, [
    editorKey,
    request,
    images,
    scope,
    category,
    provider,
    accountId,
    archivedOnly,
    missingImages,
    planError,
  ]);
  return {
    initialEditor,
    request,
    setRequest,
    images,
    setImages,
    missingImages,
    setMissingImages,
    planError,
    setPlanError,
    scope,
    setScope,
    category,
    setCategory,
    provider,
    setProvider,
    accountId,
    setAccountId,
    archivedOnly,
    setArchivedOnly,
  };
}
