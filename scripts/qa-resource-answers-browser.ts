export {};
// QA transport only. The UI and business workflows remain production source.
const endpoint = "http://127.0.0.1:5199";
const previewMode = new URLSearchParams(location.search).get("preview");
async function request(path: string, body: unknown) {
  const r = await fetch(endpoint + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await r.json();
  if (result.error) throw Error(result.error);
  if (
    path === "/" &&
    (body as { method?: string }).method === "snapshot" &&
    previewMode?.startsWith("intake-")
  )
    result.value.dataPath += `#${previewMode}`;
  return result.value;
}
window.panxu = {
  invoke: (method, args) => request("/", { method, args }),
  onChanged: () => () => {},
  onUpdateChanged: () => () => {},
};
const preview = previewMode !== null;
if (preview) {
  const snapshot = await request("/", { method: "snapshot" });
  if (previewMode?.startsWith("intake-")) {
    document.title = "录入资源 · 只读界面预览";
    localStorage.setItem("panxu-ui-v1", JSON.stringify({ page: "intake" }));
    localStorage.setItem(
      `panxu-intake-v1:${snapshot.dataPath}:new:new`,
      JSON.stringify({
        provider: "quark",
        accountId: snapshot.accounts[0].id,
        sourceText: "https://pan.quark.cn/s/ownpreview1",
        code: "",
        title: "自制英语学习资料（本地界面示例）",
        category: "效率办公",
        tags: "学习资料",
        summary: "本地只读预览，不提交、不访问网盘。",
        directory: "/盘序资源",
        isOwnResource: previewMode === "intake-owned",
      }),
    );
  } else {
    const [run] = await request("/", { method: "resourceAnswers.list" });
    localStorage.setItem(
      "panxu-ui-v1",
      JSON.stringify({ page: "resource-answers" }),
    );
    localStorage.setItem(
      `panxu-resource-answers:${snapshot.dataPath}`,
      JSON.stringify({
        question: run.input.question,
        resources: run.resources,
        style: run.input.style,
        format: run.input.format,
        instruction: "",
        selectedId: run.id,
      }),
    );
  }
  document.getElementById("qa-controls")!.textContent =
    "本地示例预览 · 不调用模型 · 不写入当前工作空间";
} else if (!sessionStorage.getItem("qa-resource-answers-started")) {
  localStorage.setItem("panxu-ui-v1", JSON.stringify({ page: "workbench" }));
  sessionStorage.setItem("qa-resource-answers-started", "yes");
}
if (!preview) {
  document.getElementById("qa-fail")!.onclick = () =>
    void request("/control", { action: "fail" });
  document.getElementById("qa-history")!.onclick = () =>
    void request("/control", { action: "history" });
  document.getElementById("qa-state")!.onclick = () =>
    void request("/state", {}).then((v) => {
      document.getElementById("qa-output")!.textContent = JSON.stringify({
        textCalls: v.calls,
        imageCalls: v.imageCalls,
        textCopied: !!v.clipboard.text,
        richImages: (v.clipboard.html.match(/<img /g) || []).length,
        imageBytes: v.clipboard.imageBytes,
        transfers: v.transfers,
        shares: v.shares,
      });
    });
}
new MutationObserver(() => {
  document
    .querySelectorAll<HTMLImageElement>('img[src^="panxu-media://asset/"]')
    .forEach((img) => {
      img.src = endpoint + "/asset/" + img.src.split("/").at(-1);
    });
}).observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["src"],
});
void import("../src/main");
