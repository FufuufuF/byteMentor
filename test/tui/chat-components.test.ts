import { stripVTControlCharacters } from "node:util";
import { describe, expect, test } from "vitest";
import {
  AssistantMessageComponent,
  createTheme,
  FooterComponent,
  HeaderComponent,
  StatusComponent,
  UserMessageComponent,
  visibleWidth,
} from "@byte-mentor/tui";

const theme = createTheme("dark");

function plain(lines: string[]): string {
  return stripVTControlCharacters(lines.join("\n"));
}

function expectWidthSafe(lines: string[], width: number): void {
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
}

describe("chat visual components", () => {
  // Renders CJK Markdown inside the user card while keeping every output line within the viewport.
  test.each([40, 80])("renders a width-safe user message at %s columns", (width) => {
    const component = new UserMessageComponent("**你好**，解释一下 Promise。", theme);
    const lines = component.render(width);

    expect(plain(lines)).toContain("你好");
    expectWidthSafe(lines, width);
  });

  // Appends streamed chunks into one assistant component and treats completion content as final truth.
  test("updates one assistant message without duplicating completed content", () => {
    const component = new AssistantMessageComponent(theme);
    component.appendDelta("Hello ");
    component.appendDelta("world");
    expect(plain(component.render(40))).toContain("Hello world");

    component.complete("Hello world!");
    const rendered = plain(component.render(40));
    expect(rendered).toContain("Hello world!");
    expect(rendered.match(/Hello/g)).toHaveLength(1);
  });

  // Keeps Byte Mentor branding separate from pi and degrades footer metadata by viewport priority.
  test("renders branded header and responsive footer", () => {
    const header = new HeaderComponent(theme);
    const footer = new FooterComponent(
      {
        workspaceRoot: "/very/long/workspace/path/to/byte-mentor",
        model: "gpt-test",
        sessionId: "session-123",
        status: "idle",
      },
      theme,
    );

    expect(plain(header.render(80))).toContain("Byte Mentor");
    expect(plain(header.render(80)).toLowerCase()).not.toContain("pi coding");
    expect(plain(footer.render(120))).toContain("session-123");
    expect(plain(footer.render(40))).toContain("gpt-test");
    expect(plain(footer.render(40))).not.toContain("session-123");
    expectWidthSafe(footer.render(40), 40);
  });

  // Maps working, error, and deferred-exit states to stable human-readable terminal text.
  test("renders all active status messages", () => {
    const status = new StatusComponent(theme);

    status.setState("working");
    expect(plain(status.render(40))).toContain("Working");
    status.setState("error", "provider unavailable");
    expect(plain(status.render(40))).toContain("provider unavailable");
    status.setState("exit_pending");
    expect(plain(status.render(40))).toContain("Exiting after this turn");
  });

  // Exercises emoji, CJK, and a long path together so ANSI styling never causes horizontal overflow.
  test("keeps wide characters and long paths within narrow terminals", () => {
    const user = new UserMessageComponent("学习 🚀 中文与 emoji", theme);
    const footer = new FooterComponent(
      {
        workspaceRoot: "/workspace/包含中文/and/a/very/long/path",
        model: "model-with-a-long-name",
        status: "working",
      },
      theme,
    );

    expectWidthSafe(user.render(40), 40);
    expectWidthSafe(footer.render(40), 40);
  });
});
