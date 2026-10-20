import type { Provider } from "../../shared/types";
import { providerName } from "./labels";
import quark from "../assets/providers/quark.png";
import baidu from "../assets/providers/baidu.ico";
import uc from "../assets/providers/uc.png";
import xunlei from "../assets/providers/xunlei.png";
import guangya from "../assets/providers/guangya.png";
import pikpak from "../assets/providers/pikpak.png";
import "./provider-icon.css";

const icons = { quark, baidu, uc, xunlei, guangya, pikpak } satisfies Record<
  Provider,
  string
>;

/** Local, official brand assets; no network request or letter-avatar fallback. */
export function ProviderIcon({
  provider,
  size = "large",
  decorative = false,
}: {
  provider: Provider;
  size?: "small" | "medium" | "large";
  decorative?: boolean;
}) {
  return (
    <span
      className={`provider-icon provider-icon--${size}`}
      data-provider={provider}
    >
      <img
        src={icons[provider]}
        alt={decorative ? "" : `${providerName(provider)}图标`}
        draggable={false}
      />
    </span>
  );
}
