import type { Env } from "./types";

/** Verification is server-rendered on the canonical home page and survives content updates. */
export function searchVerification(
  request: Request,
  response: Response,
  env: Env,
) {
  const url = new URL(request.url),
    value = env.BING_SITE_VERIFICATION;
  if (
    !value ||
    !/^[A-Fa-f0-9]{32}$/.test(value) ||
    url.origin !== env.PUBLIC_ORIGIN ||
    url.pathname !== "/" ||
    url.search ||
    response.status !== 200 ||
    !response.headers.get("Content-Type")?.includes("text/html")
  )
    return response;
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(`<meta name="msvalidate.01" content="${value}">`, {
          html: true,
        });
      },
    })
    .transform(response);
}
