// Synthetic public-share shape; contains no downloaded user profiles or sessions.
export const pipixItemId = "7595847114874165558";
export const pipixCommentId = "7605172050759516980";
export const pipixImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
export function pipixHtml({
  id = pipixItemId,
  video = false,
  images = 1,
  empty = false,
}: { id?: string; video?: boolean; images?: number; empty?: boolean } = {}) {
  const item = {
    item_id: Number(id),
    item_id_str: id,
    item_type: video ? 2 : 1,
    author: {
      name: "图文分享者",
      avatar: { url_list: [{ url: "https://example.invalid/avatar.png" }] },
    },
    content: empty
      ? ""
      : "今天的小发现：认真观察，日常生活也有许多有趣的瞬间。",
    note: {
      multi_image: Array.from({ length: images }, (_, i) => ({
        is_gif: false,
        download_list: [
          {
            url: `https://p9-ppx-sign.byteimg.com/source-${i}.jpeg?x-signature=public-example`,
          },
        ],
        url_list: [
          { url: "https://example.invalid/never-prefer-display.webp" },
        ],
      })),
    },
    stats: { comment_count: 125 },
    video: video ? { cover: "https://example.invalid/not-an-image" } : null,
  };
  const c = {
    comment_id: Number(pipixCommentId),
    comment_id_str: pipixCommentId,
    text: "换个角度，平凡的小事也有惊喜。",
    user: { name: "热心网友" },
    like_count: 42,
    tag_info: { content: "神评" },
    item,
  };
  return `<html><script type="application/json" id="RENDER_DATA">${encodeURIComponent(JSON.stringify({ ppxItemDetail: { item }, ppxCellComment: { cell_comments: [{ comment_info: c }, { comment_info: c }, { comment_info: { ...c, comment_id_str: "7605139138790032180", text: "这个角度很有趣。", like_count: 0, tag_info: {} } }] } }))}</script></html>`;
}
