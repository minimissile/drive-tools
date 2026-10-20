/** Explicit outcomes: brand blue is reserved for guidance and progress. */
export type FeedbackTone = "success" | "error" | "warning" | "info";
export interface FeedbackMessage {
  text: string;
  tone: FeedbackTone;
}
export type Notify = (text: string, tone: FeedbackTone) => void;
