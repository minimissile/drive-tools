import { forwardRef } from "react";
import { Cpu, type LucideProps } from "lucide-react";

/** Shared AI action mark. Keep size, stroke and currentColor consistent with other controls. */
export const AiIcon = forwardRef<SVGSVGElement, LucideProps>(
  function AiIcon(props, ref) {
    return <Cpu ref={ref} aria-hidden="true" {...props} />;
  },
);
