/** Search highlighting is presentation metadata; keep the original in the response archive. */
export const pipixListText = (value: unknown) =>
  typeof value === "string" ? value.replace(/<\/?em>/gi, "").trim() : "";
