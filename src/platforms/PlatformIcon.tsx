import { Globe } from "lucide-react";
import sources from "../assets/websites/sources.json";
import "./platform-icon.css";

const assets = import.meta.glob<string>(
  "../assets/websites/*.{png,ico,jpg,webp}",
  { eager: true, query: "?url", import: "default" },
);

/** Official site icons bundled locally; viewing accounts never contacts a website. */
export function PlatformIcon({
  platform,
  size = "large",
  decorative = true,
}: {
  platform: string;
  size?: "small" | "large";
  decorative?: boolean;
}) {
  const source = sources[platform as keyof typeof sources];
  const src = source && assets[`../assets/websites/${source.file}`];
  return (
    <span className={`platform-icon platform-icon--${size}`}>
      {src ? (
        <img
          src={src}
          alt={decorative ? "" : `${source.name}图标`}
          draggable={false}
        />
      ) : (
        <Globe
          size={size === "small" ? 16 : 22}
          aria-label={decorative ? undefined : "网站"}
          aria-hidden={decorative}
        />
      )}
    </span>
  );
}
