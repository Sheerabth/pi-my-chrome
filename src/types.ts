/** Shared shapes: observed pages and actions. */

export interface PageAction {
  id: string;
  kind: string;
  label: string;
  node?: number;
  /** Index into the observe call's frame list (0 = main page). */
  frame?: number;
  role?: string;
  value?: string;
  current_value?: string;
  [key: string]: unknown;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  actions: PageAction[];
  scroll: unknown;
  marker: unknown;
  page_key: unknown;
  guards: Record<string, unknown>;
  /** Frame urls from the observe call (index 0 is the main page, omitted). */
  frameUrls?: string[];
  /** Console errors + failed requests since the previous observe (diagnosis). */
  failedRequests?: { url: string; status: number }[];
  fingerprint?: string;
  screenshot?: string;
  omitted_actions?: number;
  [key: string]: unknown;
}
