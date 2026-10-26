/** Serialized into the official page. No credentials or unrelated feed content leave the page. */
export async function weiboPublisherPage(input: {
  action: "inspect" | "fill" | "assert" | "submit";
  taskId: string;
  uid: string;
  text: string;
  visibility: "public" | "self";
  aiAssisted: boolean;
  images?: { name: string; mime: string; base64: string; sha256: string }[];
  hashes: string[];
}) {
  const page = window as any;
  const fail = (message: string): never => {
    throw new Error(message);
  };
  if (
    location.protocol !== "https:" ||
    !["weibo.com", "www.weibo.com"].includes(location.hostname) ||
    !["/", "/mygroups"].includes(location.pathname)
  )
    fail("请保持微博官方首页打开，当前页面不是受支持的发布器。");
  const uid = String(
    page.$CONFIG?.uid ??
      page.$CONFIG?.user?.idstr ??
      page.$CONFIG?.user?.id ??
      "",
  );
  if (uid !== input.uid) fail("微博窗口当前账号与任务不一致，已停止操作。");
  const textarea = Array.from(document.querySelectorAll("textarea")).find(
    (node) =>
      node.getBoundingClientRect().width > 0 &&
      /有什么新鲜事|分享给大家/.test(node.placeholder),
  );
  if (!textarea)
    fail("未找到微博首页的图文发布框，请完成登录或安全验证后重试。");
  let publisher: any;
  const accept = (proxy: any) =>
    proxy &&
    typeof proxy.toolbarPublish === "function" &&
    typeof proxy.pasteImg === "function" &&
    typeof proxy.content === "string" &&
    proxy.$refs?.image &&
    (proxy.$el?.contains?.(textarea) ||
      proxy.$refs.form?.$el?.contains?.(textarea) ||
      proxy.$refs.form?.$refs?.form === textarea);
  for (
    let node: any = textarea;
    node && !publisher;
    node = node.parentElement
  ) {
    for (
      let component = node.__vueParentComponent;
      component;
      component = component.parent
    ) {
      const proxy = component.proxy;
      if (accept(proxy)) {
        publisher = proxy;
        break;
      }
    }
  }
  // Vue's production renderer omits per-element component markers, but keeps its mounted vnode tree.
  const seen = new Set<any>();
  const visit = (vnode: any) => {
    if (!vnode || typeof vnode !== "object" || publisher || seen.has(vnode))
      return;
    seen.add(vnode);
    const instance = vnode.component;
    if (accept(instance?.proxy)) {
      publisher = instance.proxy;
      return;
    }
    if (instance) visit(instance.subTree);
    if (Array.isArray(vnode.children)) vnode.children.forEach(visit);
    if (Array.isArray(vnode.dynamicChildren))
      vnode.dynamicChildren.forEach(visit);
    visit(vnode.suspense?.activeBranch);
  };
  if (!publisher) {
    for (const node of Array.from(document.querySelectorAll("[data-v-app]"))) {
      visit((node as any)._vnode);
      visit((node as any).__vue_app__?._container?._vnode);
    }
  }
  if (!publisher) fail("微博发布器结构已变化，尚未填写或提交，请更新适配。");
  const pictures = () =>
    Array.isArray(publisher.pic_id) ? publisher.pic_id : [];
  const visibilityControl = publisher.$refs.tools?.$refs.visible;
  const marker = () => page.__panxuWeiboEditor;
  const matches = () =>
    marker()?.taskId === input.taskId &&
    marker()?.text === input.text &&
    JSON.stringify(marker()?.hashes) === JSON.stringify(input.hashes);
  const textMatches = () =>
    publisher.content === input.text && textarea!.value === input.text;
  const pending = () =>
    publisher.pic_id === "loading" ||
    publisher.$refs.image.uploading ||
    pictures().some((image: any) => image.status === 1 || image.status === 2);
  const check = () => {
    if (!matches() || !textMatches())
      fail("微博发布框内容已变化，请重新自动填写；不会覆盖手工修改。");
    const ids = pictures().map((image: any) => image.pid);
    if (
      pending() ||
      ids.length !== input.hashes.length ||
      ids.some((id: unknown) => typeof id !== "string" || !id)
    )
      fail("微博图片未全部上传成功，请在官方窗口检查后重新填写。");
    if (JSON.stringify(ids) !== JSON.stringify(marker().pictureIds))
      fail("微博图片顺序或内容已变化，请重新核对后填写。");
    if (Number(publisher.visible) !== (input.visibility === "self" ? 1 : 0))
      fail("微博可见范围已变化，请重新核对任务设置。");
    if (Number(visibilityControl?.visible) !== Number(publisher.visible))
      fail("微博可见范围控件与提交设置不一致，已停止提交。");
    if (
      publisher.toolAction ||
      publisher.schedule_timestamp ||
      Object.keys(publisher.media ?? {}).length ||
      Object.keys(publisher.vote ?? {}).length ||
      publisher.pri ||
      publisher.authority ||
      publisher.share_id ||
      publisher.monograph?.title ||
      publisher.position?.pc_title ||
      publisher.shopConfig?.some((item: any) => item.id || item.iid)
    )
      fail(
        "发布器中有排期、视频、投票、付费或其他附加内容，请先在网页处理后重试。",
      );
    if (publisher.formCount?.count > publisher.formCount?.maxcount)
      fail("文案超过此微博账号当前发布上限，请精简后重试。");
    if (
      publisher.showSelfDeclaration &&
      publisher.statementRequired &&
      !publisher.selectedDeclarationRequired
    )
      fail("微博要求选择内容声明，请在官方发布框完成后再点击确认发布。");
    if (
      publisher.currentDeclarationRequiredOption?.textfield &&
      String(publisher.declarationReprintSource ?? "").trim().length <
        publisher.currentDeclarationRequiredMinLength
    )
      fail("请先在微博完成内容声明所要求的来源说明。");
  };
  if (input.action === "inspect")
    return {
      uid,
      imageCount: pictures().length,
      hasContent: !!publisher.content || pictures().length > 0,
    };
  if (input.action === "fill") {
    if (
      !matches() &&
      (publisher.content || publisher.pic_id === "loading" || pictures().length)
    )
      fail(
        "微博发布框已有内容。请先保存或清空网页草稿，再自动填写；现有内容未覆盖。",
      );
    if (
      matches() &&
      (!textMatches() ||
        (marker().pictureIds &&
          JSON.stringify(marker().pictureIds) !==
            JSON.stringify(pictures().map((image: any) => image.pid))))
    )
      fail("网页中的任务内容已被手工改动，请先保存或清空网页草稿。");
    if (!matches()) {
      if (typeof visibilityControl?.visibleChange !== "function")
        fail("未找到微博可见范围控件，尚未填写或提交。");
      page.__panxuWeiboEditor = {
        taskId: input.taskId,
        text: input.text,
        hashes: input.hashes,
      };
      if (publisher.aiConfig) publisher.aiConfig.enablePic2Text = false;
      visibilityControl.visibleChange(
        null,
        input.visibility === "self" ? 1 : 0,
        undefined,
        false,
      );
      if (input.aiAssisted) {
        const declaration = publisher.declarationRequiredOptions?.find(
          (option: any) => /AI|人工智能/i.test(option.label),
        );
        if (declaration)
          publisher.selectedDeclarationRequired = declaration.value;
        const optional = publisher.declarationOptionalOptions?.find(
          (option: any) => /AI|人工智能/i.test(option.label),
        );
        if (
          optional &&
          !publisher.selectedDeclarationOptional?.includes(optional.value)
        )
          publisher.selectedDeclarationOptional = [
            ...(publisher.selectedDeclarationOptional ?? []),
            optional.value,
          ];
      }
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, input.text);
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      await publisher.$nextTick();
      if (!textMatches()) fail("微博未接受填写的文案，请保留页面并重试适配。");
      for (const image of input.images ?? []) {
        const bytes = Uint8Array.from(atob(image.base64), (value) =>
          value.charCodeAt(0),
        );
        publisher.pasteImg(new File([bytes], image.name, { type: image.mime }));
        await publisher.$nextTick();
      }
    }
    const deadline = Date.now() + 120000;
    while (
      (pending() || pictures().length !== input.hashes.length) &&
      Date.now() < deadline
    ) {
      const failed = publisher.$refs.image.upload_list?.find(
        (image: any) => image.status === 4 || image.error,
      );
      if (failed) fail("微博图片上传失败，请在官方窗口检查网络或平台提示。");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    marker().pictureIds = pictures().map((image: any) => image.pid);
    check();
  } else {
    check();
    if (input.action === "submit") {
      let scope: Element | null = textarea!;
      let button: HTMLButtonElement | undefined;
      while (scope && !button) {
        button = Array.from(scope.querySelectorAll("button")).find(
          (node) =>
            /^(发送|发布)$/.test(node.textContent?.trim() ?? "") &&
            node.getBoundingClientRect().width > 0,
        );
        scope = scope.parentElement;
      }
      if (!button || button.disabled || publisher.ispost)
        fail("微博发布按钮暂不可用，请检查网页中的必填项或安全验证。");
      button!.click();
    }
  }
  return { uid, imageCount: pictures().length, visibility: input.visibility };
}
