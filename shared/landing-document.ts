/** The same format policy is used by the picker, editor and backend reader. */
export const landingDocumentExtensions = ["pdf", "docx", "txt", "md"] as const;
export function isLandingDocument(name: string) {
  const extension = name.split(".").at(-1)?.toLowerCase();
  return landingDocumentExtensions.some((value) => value === extension);
}
