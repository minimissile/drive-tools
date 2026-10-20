import { Select } from "../ui/Select";
import {
  channelProfiles,
  contentFormats,
  type ContentFormat,
} from "../../shared/channels";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { useAppActions, useAppActivity } from "../state";
import { Button } from "../ui/primitives";

import type { BrowserBinding } from "../../shared/types";

export function BindingOpen({ binding }: { binding: BrowserBinding }) {
  const { command } = useAppActions(),
    { busy } = useAppActivity();
  const [format, setFormat] = useState<ContentFormat>(
    channelProfiles[binding.platform].formats[0],
  );
  return (
    <div className="binding-open-actions">
      <Select
        aria-label={`${binding.alias}联调形式`}
        value={format}
        onValueChange={(nextValue) => setFormat(nextValue as ContentFormat)}
        items={[
          ...channelProfiles[binding.platform].formats.map((f) => ({
            value: f,
            label: contentFormats[f].name,
          })),
        ]}
      />
      <Button
        quiet
        disabled={busy > 0}
        onClick={() =>
          void command(
            "binding.open",
            { id: binding.id, contentFormat: format },
            {
              text: "官方入口已打开，请在窗口内核对账号与实际发布能力。",
              tone: "info",
            },
          )
        }
      >
        <ExternalLink size={14} />
        打开入口联调
      </Button>
    </div>
  );
}
