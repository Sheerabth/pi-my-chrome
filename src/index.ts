/** pi-my-chrome: Pi browses with your Chrome profile. Search, open, navigate. */

export { CloakBrowserAdapter, StalePage, mergeFrameSnapshots } from "./cloakAdapter.js";
export type { FrameSnap, LaunchOpts } from "./cloakAdapter.js";
export { ensureEnv, loadConfig, loadDotEnvFile, parseDotEnv, redacted } from "./config.js";
export type { ChromeConfig } from "./config.js";
export { ensureProfileCopy, wipeProfileCopy } from "./profile.js";
export { SimpleBrowser, formatPage } from "./simple.js";
export { search, searchMany, open, detectWall, unwrapUrl, isJunkResult, looksRedirect, cleanMarkdown, registerEngine } from "./search.js";
export type { SearchEngine, SearchResult, OpenedPage, BrowserOpts, EngineDef } from "./search.js";
export { navigate, read, act, back, forward, press, screenshot, clickAt, savePdf, downloads, tabList, tabSwitch, tabClose, find, searchPage, wait, videoSeek, closeSession, resetSession, hasSession } from "./session.js";
export { videoTranscript, videoIdFromUrl } from "./video.js";
export type { VideoTranscript, TranscriptSegment } from "./video.js";
export type { SessionOpts } from "./session.js";
export type { PageAction, PageSnapshot } from "./types.js";
