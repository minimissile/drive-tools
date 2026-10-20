import { useMemo, useSyncExternalStore } from "react";

export function useMediaQuery(query: string) {
  const media = useMemo(() => matchMedia(query), [query]);
  return useSyncExternalStore(
    (onChange) => {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => media.matches,
    () => false,
  );
}
