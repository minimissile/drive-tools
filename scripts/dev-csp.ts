/** Vite uses a blob SharedWorker to wait for its HMR socket after a disconnect. */
export function developmentCspHtml(html: string, development: boolean) {
  return development
    ? html.replace(
        "script-src 'self';",
        "script-src 'self' 'unsafe-inline'; worker-src 'self' blob:;",
      )
    : html;
}
