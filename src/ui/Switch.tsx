import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ComponentProps } from "react";
import "./switch.css";

/** Controlled switch; callers own its label and business state. */
export function Switch(
  props: Omit<ComponentProps<typeof BaseSwitch.Root>, "children" | "className">,
) {
  return (
    <BaseSwitch.Root {...props} className="switch-control">
      <BaseSwitch.Thumb className="switch-thumb" />
    </BaseSwitch.Root>
  );
}
