import { net, type Session } from "electron";

type ProxyCredentials = {
  host: string;
  port: number;
  username: string;
  password: string;
};
const authentication = new WeakMap<Session, ProxyCredentials>();
export function setSessionProxyCredentials(
  profile: Session,
  value?: ProxyCredentials,
) {
  if (value) authentication.set(profile, value);
  else authentication.delete(profile);
}

/** Session.fetch has no per-request authentication callback. Authenticated proxies use
 * net.request's callback, scoped to this Session and this proxy, including background IO. */
export async function browserSessionFetch(
  profile: Session,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const credentials = authentication.get(profile);
  if (!credentials)
    return profile.fetch(url, init) as unknown as Promise<Response>;
  const encoded = new Request(url, init),
    body = encoded.body ? Buffer.from(await encoded.arrayBuffer()) : null;
  const signal = init.signal ?? AbortSignal.timeout(45000);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = net.request({
      url,
      method: encoded.method,
      session: profile,
      useSessionCookies: init.credentials !== "omit",
      redirect: "error",
    });
    for (const [name, value] of encoded.headers) request.setHeader(name, value);
    let settled = false;
    const abort = () => request.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    request.on("login", (auth, callback) => {
      if (
        auth.isProxy &&
        auth.host === credentials.host &&
        auth.port === credentials.port
      )
        callback(credentials.username, credentials.password);
      else callback();
    });
    request.on("error", (error) => {
      cleanup();
      if (!settled) reject(error);
    });
    request.on("abort", () => {
      cleanup();
      if (!settled)
        reject(new Error("浏览器环境请求已停止，请检查网络后重试。"));
    });
    request.on("response", (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers))
        for (const item of Array.isArray(value) ? value : [value])
          if (item !== undefined) headers.append(name, String(item));
      let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on("data", (chunk) => {
            if (!closed) controller.enqueue(new Uint8Array(chunk));
          });
          response.on("end", () => {
            cleanup();
            if (!closed) {
              closed = true;
              controller.close();
            }
          });
          response.on("error", (error) => {
            cleanup();
            if (!closed) {
              closed = true;
              controller.error(error);
            }
          });
          request.on("abort", () => {
            if (!closed) {
              closed = true;
              controller.error(new Error("代理连接已中断。"));
            }
          });
          request.on("error", (error) => {
            if (!closed) {
              closed = true;
              controller.error(error);
            }
          });
        },
        cancel() {
          closed = true;
          cleanup();
          request.abort();
        },
      });
      settled = true;
      resolve(
        new Response(
          [101, 204, 205, 304].includes(response.statusCode) ||
            encoded.method === "HEAD"
            ? null
            : stream,
          {
            status: response.statusCode,
            statusText: response.statusMessage,
            headers,
          },
        ),
      );
    });
    if (body) request.write(body);
    request.end();
  });
}
