import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

/**
 * Minimal ANSI palette for the interactive mode. Hand-rolled 16-color codes
 * instead of pi's theme files: no asset loading, works on every terminal,
 * and the presentation layer stays a leaf module (nothing here imports the
 * harness runtime).
 */

const RESET = "\x1b[0m";

const fg =
  (code: string) =>
  (text: string): string =>
    `${code}${text}${RESET}`;

export const t = {
  dim: fg("\x1b[90m"),
  muted: fg("\x1b[37m"),
  accent: fg("\x1b[96m"),
  success: fg("\x1b[92m"),
  error: fg("\x1b[91m"),
  warning: fg("\x1b[93m"),
  added: fg("\x1b[92m"),
  removed: fg("\x1b[91m"),
  userBg: (text: string): string => `\x1b[100m${text}${RESET}`,
};

export const bold = (text: string): string => `\x1b[1m${text}${RESET}`;

const italic = (text: string): string => `\x1b[3m${text}${RESET}`;
const strikethrough = (text: string): string => `\x1b[9m${text}${RESET}`;
const underline = (text: string): string => `\x1b[4m${text}${RESET}`;

export const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: t.accent,
  linkUrl: t.dim,
  code: t.warning,
  codeBlock: (text) => text,
  codeBlockBorder: t.dim,
  quote: t.muted,
  quoteBorder: t.dim,
  hr: t.dim,
  listBullet: t.accent,
  bold,
  italic,
  strikethrough,
  underline,
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: t.accent,
  selectedText: bold,
  description: t.dim,
  scrollInfo: t.dim,
  noMatch: t.dim,
};

export const editorTheme: EditorTheme = {
  borderColor: t.dim,
  selectList: selectListTheme,
};
