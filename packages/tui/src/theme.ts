import { Chalk } from "chalk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

export type ThemeKind = "dark" | "light";

export interface ByteMentorTheme {
  kind: ThemeKind;
  foreground: {
    accent(text: string): string;
    success(text: string): string;
    error(text: string): string;
    warning(text: string): string;
    muted(text: string): string;
    text(text: string): string;
  };
  background: {
    userMessage(text: string): string;
    toolPending(text: string): string;
    toolSuccess(text: string): string;
    toolError(text: string): string;
  };
  markdown: MarkdownTheme;
  editor: EditorTheme;
}

interface Palette {
  accent: string;
  border: string;
  success: string;
  error: string;
  warning: string;
  muted: string;
  text: string;
  userMessageBg: string;
  toolPendingBg: string;
  toolSuccessBg: string;
  toolErrorBg: string;
  heading: string;
  link: string;
  code: string;
}

const PALETTES: Record<ThemeKind, Palette> = {
  dark: {
    accent: "#8abeb7",
    border: "#5f87ff",
    success: "#b5bd68",
    error: "#cc6666",
    warning: "#f0c674",
    muted: "#808080",
    text: "#d4d4d4",
    userMessageBg: "#343541",
    toolPendingBg: "#282832",
    toolSuccessBg: "#283228",
    toolErrorBg: "#3c2828",
    heading: "#f0c674",
    link: "#81a2be",
    code: "#b5bd68",
  },
  light: {
    accent: "#5a8080",
    border: "#547da7",
    success: "#588458",
    error: "#aa5555",
    warning: "#9a7326",
    muted: "#6c6c6c",
    text: "#1f2328",
    userMessageBg: "#e8e8e8",
    toolPendingBg: "#e8e8f0",
    toolSuccessBg: "#e8f0e8",
    toolErrorBg: "#f0e8e8",
    heading: "#9a7326",
    link: "#547da7",
    code: "#588458",
  },
};

// Creates the fixed startup palette and the pi-tui theme contracts used by all view components.
export function createTheme(kind: ThemeKind): ByteMentorTheme {
  const palette = PALETTES[kind];
  const chalk = new Chalk({ level: 3 });
  const foreground = {
    accent: (text: string) => chalk.hex(palette.accent)(text),
    success: (text: string) => chalk.hex(palette.success)(text),
    error: (text: string) => chalk.hex(palette.error)(text),
    warning: (text: string) => chalk.hex(palette.warning)(text),
    muted: (text: string) => chalk.hex(palette.muted)(text),
    text: (text: string) => chalk.hex(palette.text)(text),
  };
  const selectList: SelectListTheme = {
    selectedPrefix: foreground.accent,
    selectedText: (text) => chalk.bold(text),
    description: foreground.muted,
    scrollInfo: foreground.muted,
    noMatch: foreground.muted,
  };
  const markdown: MarkdownTheme = {
    heading: (text) => chalk.bold.hex(palette.heading)(text),
    link: (text) => chalk.hex(palette.link)(text),
    linkUrl: foreground.muted,
    code: (text) => chalk.hex(palette.accent)(text),
    codeBlock: (text) => chalk.hex(palette.code)(text),
    codeBlockBorder: foreground.muted,
    quote: foreground.muted,
    quoteBorder: foreground.muted,
    hr: foreground.muted,
    listBullet: foreground.accent,
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
  };

  return {
    kind,
    foreground,
    background: {
      userMessage: (text) => chalk.bgHex(palette.userMessageBg)(text),
      toolPending: (text) => chalk.bgHex(palette.toolPendingBg)(text),
      toolSuccess: (text) => chalk.bgHex(palette.toolSuccessBg)(text),
      toolError: (text) => chalk.bgHex(palette.toolErrorBg)(text),
    },
    markdown,
    editor: {
      borderColor: (text) => chalk.hex(palette.border)(text),
      selectList,
    },
  };
}
