import { z } from "zod";

/** Only connection keys editable on the settings page may be read by the form. */
export const settingsSecretKind = z.enum([
  "openrouter",
  "bit",
  "pipix:tikhub",
  "5118:longtail",
  "5118:suggest",
  "5118:metrics",
  "5118:radar",
]);
export type SettingsSecretKind = z.infer<typeof settingsSecretKind>;
export interface SettingsSecretPreview {
  configured: boolean;
  masked: string;
}
