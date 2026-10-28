import { useEffect, useRef, useState } from "react";
import { focusSection } from "../ui/SectionNav";
const items = [
  ["settings-ai", "AI与预算"],
  ["settings-traffic", "5118接口"],
  ["settings-sources", "内容数据源"],
  ["settings-notes", "知识库"],
  ["settings-browser", "比特连接"],
  ["settings-bindings", "发布映射"],
  ["settings-maintenance", "备份与更新"],
] as const;
export function SettingsNav() {
  const navigation = useRef<HTMLElement>(null);
  const [active, setActive] = useState<string>(items[0][0]);
  useEffect(() => {
    let frame = 0;
    const node = navigation.current;
    const owner = node?.closest<HTMLElement>(".settings-page");
    const observer = new ResizeObserver(() => {
      owner?.style.setProperty(
        "--settings-nav-height",
        `${node?.getBoundingClientRect().height ?? 0}px`,
      );
    });
    if (node) observer.observe(node);
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nav = document
          .querySelector(".settings-nav")
          ?.getBoundingClientRect();
        const threshold = nav && nav.width > 200 ? nav.bottom + 24 : 140;
        const sections = items
          .map(([id]) => document.getElementById(id))
          .filter((node): node is HTMLElement => !!node);
        const current =
          sections
            .filter((node) => node.getBoundingClientRect().top <= threshold)
            .at(-1) ?? sections[0];
        if (current) setActive(current.id);
      });
    };
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      owner?.style.removeProperty("--settings-nav-height");
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, []);
  return (
    <nav ref={navigation} className="settings-nav" aria-label="设置分区">
      {items.map(([id, label]) => (
        <a
          key={id}
          href={`#${id}`}
          aria-current={active === id ? "location" : undefined}
          onClick={(event) => {
            event.preventDefault();
            focusSection(id);
            setActive(id);
          }}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
