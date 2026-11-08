import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWechatRemoteImageUrl,
  wechatPreviewImageSource,
  isPublicWechatImageAddress,
  assertWechatPreviewBytes,
} from "../desktop/wechat-image-policy";

test("original WeChat image fragments are ignored while path and query remain intact", () => {
  const image =
    "https://mmbiz.qpic.cn/mmbiz_png/source/640?wx_fmt=png&wxfrom=5";
  assert.equal(
    normalizeWechatRemoteImageUrl(`${image}#imgIndex=0`).href,
    image,
  );
  assert.equal(
    normalizeWechatRemoteImageUrl(`${image}#imgIndex=1`).href,
    image,
  );
  assert.equal(normalizeWechatRemoteImageUrl(image).href, image);
  assert.equal(
    normalizeWechatRemoteImageUrl(
      "https://mmbiz.qlogo.cn/source.png#other-fragment",
    ).hash,
    "",
  );
});

test("fragment normalization does not relax HTTPS, credentials, port or local hostname checks", () => {
  for (const value of [
    "http://mmbiz.qpic.cn/source.png#imgIndex=0",
    "https://user:password@mmbiz.qpic.cn/source.png#imgIndex=0",
    "https://mmbiz.qpic.cn:8443/source.png#imgIndex=0",
    "https://localhost/source.png#imgIndex=0",
    "https://images.local/source.png#imgIndex=0",
    "https://images.internal/source.png#imgIndex=0",
    "not an image URL",
  ])
    assert.throws(() => normalizeWechatRemoteImageUrl(value), {
      code: "WECHAT_IMAGE_URL",
    });
});

test("remote normalization never accepts or rewrites controlled local-media URLs", () => {
  const local = `panxu-media://wechat/${"a".repeat(64)}.png`;
  for (const value of [local, `${local}#imgIndex=0`, `${local}?name=example`])
    assert.throws(() => normalizeWechatRemoteImageUrl(value), {
      code: "WECHAT_IMAGE_URL",
    });
});

test("a redirect target uses the same fragment normalization and URL checks", () => {
  const base = new URL("https://mmbiz.qpic.cn/path/source.png?wx_fmt=png");
  const redirected = new URL("../source.png?wx_fmt=jpeg#imgIndex=1", base);
  assert.equal(
    normalizeWechatRemoteImageUrl(redirected.href).href,
    "https://mmbiz.qpic.cn/source.png?wx_fmt=jpeg",
  );
  assert.throws(
    () =>
      normalizeWechatRemoteImageUrl(
        new URL("http://mmbiz.qpic.cn/source.png#imgIndex=1", base).href,
      ),
    { code: "WECHAT_IMAGE_URL" },
  );
});

test("preview protocol accepts only one encoded HTTPS source on GET or HEAD", () => {
  const source =
    "https://mmbiz.qpic.cn/source.png?wx_fmt=png&wxfrom=5#imgIndex=1";
  const preview = `panxu-media://wechat-image/?url=${encodeURIComponent(source)}`;
  for (const method of ["GET", "HEAD"])
    assert.equal(
      wechatPreviewImageSource(preview, method),
      source.split("#")[0],
    );
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"])
    assert.throws(() => wechatPreviewImageSource(preview, method), {
      code: "WECHAT_IMAGE_PREVIEW",
    });
  for (const value of [
    preview + "&url=https%3A%2F%2Fexample.com%2Fsecond.png",
    preview + "&other=1",
    preview + "#outer-fragment",
    preview.replace("/?", "/path?"),
    preview.replace("wechat-image", "wechat"),
    preview.replace("panxu-media:", "https:"),
    preview.replace("//wechat-image", "//user:secret@wechat-image"),
    "panxu-media://wechat-image/",
    "panxu-media://wechat-image/?url=",
  ])
    assert.throws(() => wechatPreviewImageSource(value, "GET"));
});

test("preview source policy does not permit local media, non-HTTPS URLs or local hostnames", () => {
  for (const source of [
    "http://mmbiz.qpic.cn/image.png",
    "panxu-media://wechat/" + "a".repeat(64) + ".png",
    "file:///private/file.png",
    "https://localhost/image.png",
    "https://image.internal/image.png",
  ])
    assert.throws(
      () =>
        wechatPreviewImageSource(
          `panxu-media://wechat-image/?url=${encodeURIComponent(source)}`,
          "GET",
        ),
      { code: "WECHAT_IMAGE_URL" },
    );
});

test("the shared download policy rejects local, private and metadata DNS addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "not-an-ip",
  ])
    assert.equal(isPublicWechatImageAddress(address), false, address);
  for (const address of [
    "1.1.1.1",
    "8.8.8.8",
    "172.32.0.1",
    "2606:4700:4700::1111",
  ])
    assert.equal(isPublicWechatImageAddress(address), true, address);
});

test("preview byte policy accepts raster candidates but rejects HTML, SVG and oversized bodies", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZfQAAAAASUVORK5CYII=",
    "base64",
  );
  assert.doesNotThrow(() => assertWechatPreviewBytes(png));
  for (const value of [
    Buffer.alloc(0),
    Buffer.from("<html><script>bad()</script></html>"),
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>',
    ),
    Buffer.from("ordinary text"),
  ])
    assert.throws(() => assertWechatPreviewBytes(value), {
      code: "WECHAT_IMAGE_PREVIEW",
    });
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
  png.copy(oversized);
  assert.throws(() => assertWechatPreviewBytes(oversized), {
    code: "WECHAT_IMAGE_PREVIEW",
  });
});
