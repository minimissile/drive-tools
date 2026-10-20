import type { ComponentProps, ReactNode } from "react";
import "./workspace.css";

/** One scrolling work surface and an optional footer that never covers form content. */
export function Workspace({
  children,
  footer,
  className = "",
  ...props
}: ComponentProps<"div"> & { footer?: ReactNode }) {
  return (
    <div className={`workspace-frame ${className}`} {...props}>
      <div className="workspace-scroll">{children}</div>
      {footer}
    </div>
  );
}
