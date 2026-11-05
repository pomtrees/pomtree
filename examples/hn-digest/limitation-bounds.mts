// Limitation bounds of every layer of the content pipeline, defined once (TODO(limitation-bounds): watch only, the story-result margin). Pure, no imports: the
// static worker loads article.mts, which imports this. The layers nest, and limitation-bounds.test.mts asserts the chain against the
// real worker output rather than against copies of these numbers:
//   browser worker navigation log (captureBrowser)  <= NAVIGATION_LIMITATIONS_MAX lines of <= ARTICLE_LIMITATION_MAX characters
//   verified browser article = BROWSER_HOST_LIMITATIONS + the log's lines       <= ARTICLE_LIMITATIONS_MAX lines (validateArticleEvidence)
//   story evidence = the article's lines (or the host's not-analysed lines) + comment lines <= STORY_LIMITATIONS_MAX lines of
//   <= STORY_LIMITATION_MAX characters (validateStoryResult)
// These are digest schema constants, not registry keys (registry Phase 2 decision F2): the story result's worst case is sized from them.
export const ARTICLE_LIMITATIONS_MAX = 10;
export const ARTICLE_LIMITATION_MAX = 200;
// The verifier's own lines in front of a verified browser capture's log limitations (createArticleVerifier verify).
export const BROWSER_HOST_LIMITATIONS = [
  "Mechanical browser DOM innerText capture (trusted telemetry, not agent-independent or cryptographic attestation); raw body is the main HTTP response entity, not rendered DOM or wire capture",
] as const;
// What the verifier accepts from a navigation log: whatever leaves room for the host's lines in the article's bound.
export const NAVIGATION_LIMITATIONS_MAX = ARTICLE_LIMITATIONS_MAX - BROWSER_HOST_LIMITATIONS.length;
export const STORY_LIMITATIONS_MAX = 20;
export const STORY_LIMITATION_MAX = 300;
