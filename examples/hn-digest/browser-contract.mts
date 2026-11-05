// Native browser_capture arguments and artifact limits. These bound capture artifacts, NOT every page asset download. The byte ceiling,
// deadline range and per-call deadline come from ContentBounds (browser.capture.* and ext.hnDigest.articleBrowserCaptureDeadlineMs); the navigation
// report bound below is a digest schema constant.
import type { ArticleInput } from "./article.mts";
import { checkPublicUrl } from "./article.mts";
import type { ContentBounds } from "./content-bounds.mts";
export const BROWSER_NAVIGATION_BYTES = 65536;
export type NativeCaptureArgs = { url: string; maxBytes: number; deadlineMs: number };

export function parseNativeCaptureArgs(raw: unknown, b: ContentBounds): NativeCaptureArgs | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "deadlineMs,maxBytes,url" ||
    typeof value.url !== "string" ||
    !checkPublicUrl(value.url).ok ||
    !Number.isSafeInteger(value.maxBytes) ||
    (value.maxBytes as number) < 1 ||
    (value.maxBytes as number) > b.capture.maxBytesCeiling ||
    !Number.isSafeInteger(value.deadlineMs) ||
    (value.deadlineMs as number) < b.capture.deadlineMinMs ||
    (value.deadlineMs as number) > b.capture.deadlineMaxMs
  )
    return null;
  return { url: value.url, maxBytes: value.maxBytes as number, deadlineMs: value.deadlineMs as number };
}

export function nativeCaptureArgs(input: ArticleInput, b: ContentBounds): NativeCaptureArgs {
  const value = parseNativeCaptureArgs({ url: input.url, maxBytes: input.maxBytes, deadlineMs: b.browserCaptureDeadlineMs }, b);
  if (!value) throw new Error("invalid expected native capture arguments");
  return value;
}
