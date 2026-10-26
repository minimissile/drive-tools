/** Original metrics remain attached to their source; they are not platform search counts. */
export interface ContentKeyword {
  id: string;
  word: string;
  source: string;
  observedAt: string | null;
  metrics: Record<string, unknown>;
}
export interface ContentResourceMatch {
  resourceId: string;
  copyId: string;
  title: string;
  accountAlias: string;
  summary: string;
  matchedTerms: string[];
}
