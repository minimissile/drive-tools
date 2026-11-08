export interface BilibiliUploadProbe {
  ready: boolean;
  reason: "found" | "waiting" | "ambiguous" | "already_selected" | "wrong_page";
}

/** Official-page probe. Hidden file inputs are allowed only through an unambiguous upload region. */
export function bilibiliUploadPage(input: {
  kind: "video" | "image";
  editorUrl: string;
  marker: string;
  allowFallback?: boolean;
}): BilibiliUploadProbe {
  const expected = new URL(input.editorUrl);
  const pathOf = (value: string) =>
    value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    location.origin !== expected.origin ||
    pathOf(location.pathname) !== pathOf(expected.pathname)
  )
    return { ready: false, reason: "wrong_page" };
  const video = (element: HTMLInputElement) => {
    const accept = element.accept.toLowerCase();
    return accept.includes("video") || accept.includes(".mp4");
  };
  const matching = Array.from(
    document.querySelectorAll<HTMLInputElement>("input[type=file]"),
  ).filter((element) => {
    if (element.disabled) return false;
    const accept = element.accept.toLowerCase();
    return input.kind === "video"
      ? video(element)
      : ["image", ".png", ".jpg", ".jpeg", ".webp"].some((type) =>
          accept.includes(type),
        ) && !accept.includes("video");
  });
  // Observed on the logged-in video page: one active upload body plus an unrelated
  // micro-app buploader. Never choose the first of multiple global video inputs.
  const known =
    input.kind === "video"
      ? matching.filter((element) => {
          const wrapper = element.closest(
            ".upload-body-content .upload-wrp .bcc-upload-wrapper",
          );
          if (!wrapper) return false;
          const region = element.closest(".bcc-upload") ?? wrapper;
          return (
            region.getClientRects().length > 0 &&
            getComputedStyle(region).visibility !== "hidden"
          );
        })
      : [];
  if (input.kind === "video" && !known.length && input.allowFallback === false)
    return {
      ready: false,
      reason: matching.length > 1 ? "ambiguous" : "waiting",
    };
  const candidates = known.length ? known : matching;
  if (candidates.length !== 1)
    return {
      ready: false,
      reason: candidates.length ? "ambiguous" : "waiting",
    };
  if (!known.length) {
    const candidate = candidates[0],
      style = getComputedStyle(candidate);
    if (
      candidate.hidden ||
      !candidate.getClientRects().length ||
      style.visibility === "hidden" ||
      style.display === "none" ||
      style.opacity === "0"
    )
      return { ready: false, reason: "waiting" };
  }
  if (candidates[0].files?.length)
    return { ready: false, reason: "already_selected" };
  candidates[0].setAttribute(input.marker, "1");
  return { ready: true, reason: "found" };
}

/** Wait for the SPA's input without selecting a file or retrying an upload. */
export async function waitForBilibiliUpload(
  read: () => Promise<BilibiliUploadProbe>,
  guard: () => void,
  options: { timeoutMs?: number; pollMs?: number } = {},
) {
  const until = Date.now() + (options.timeoutMs ?? 30000);
  for (;;) {
    guard();
    const result = await read();
    guard();
    if (result.ready) return true;
    if (result.reason === "already_selected" || result.reason === "wrong_page")
      return false;
    const remaining = until - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(options.pollMs ?? 250, remaining)),
    );
  }
}
