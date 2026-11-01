import type { HandlerMap, HandlerServices } from "./types";
export function createPhotoPostHandlers(
  s: Pick<HandlerServices, "photoPosts">,
) {
  return {
    "photoPosts.list": (raw) => s.photoPosts.list(raw),
    "photoPosts.get": (raw) => s.photoPosts.read(raw),
    "photoPosts.save": (raw) => s.photoPosts.save(raw),
    "photoPosts.remove": (raw) => s.photoPosts.remove(raw),
    "photoPosts.export": (raw) => s.photoPosts.export(raw),
    "photoPosts.open": (raw) => s.photoPosts.open(raw),
    "photoPosts.result": (raw) => s.photoPosts.result(raw),
  } satisfies HandlerMap;
}
