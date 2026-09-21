// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSummary, summaryMarkdown, timestampSeconds } from "./summary-markdown";

afterEach(() => { document.body.replaceChildren(); });

describe("timestamp parsing", () => {
  it.each([
    ["[00:00]", 0], ["[03:25]", 205], ["[01:20:15]", 4815],
    ["[90:10]", 5410], ["[125:10]", 7510],
  ])("converts %s to seconds", (label, seconds) => {
    expect(timestampSeconds(label)).toBe(seconds);
  });

  it.each(["[03:99]", "[01:75:00]", "[1:05]", "03:25", "[-01:00]", "[99999999999999999:00]"])(
    "rejects invalid timestamps: %s", (label) => { expect(timestampSeconds(label)).toBeNull(); },
  );
});

describe("safe Markdown rendering", () => {
  it("renders Markdown structure and accessible timestamp buttons", () => {
    const fragment = renderSummary("# 강의\n\n**핵심** [03:25] 다음 [01:20:15]\n\n- 항목");
    expect(fragment.querySelector("h1")?.textContent).toBe("강의");
    expect(fragment.querySelector("strong")?.textContent).toBe("핵심");
    expect(fragment.querySelector("li")?.textContent).toBe("항목");
    const buttons = Array.from(fragment.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.dataset.seconds)).toEqual(["205", "4815"]);
    expect(buttons[0].type).toBe("button");
    expect(buttons[0].getAttribute("aria-label")).toContain("시점으로 이동");
  });

  it("does not replace timestamps in code, link attributes, or nested anchors", () => {
    const fragment = renderSummary('`[00:30]`\n\n```text\n[01:00]\n```\n\n<a href="https://example.com" title="[01:20]">[00:50]</a>\n\n[03:25]');
    expect(fragment.querySelectorAll("button")).toHaveLength(1);
    expect(fragment.querySelector("a button")).toBeNull();
    expect(fragment.querySelector("code")?.textContent).toBe("[00:30]");
    expect(fragment.querySelector("a")?.title).toBe("[01:20]");
  });

  it("removes executable HTML, embedded assets, and forged controls", () => {
    const fragment = renderSummary(`
<script>alert(1)</script>
<img src="asset://localhost/private/file" onerror="alert(1)">
<video src="https://example.com/video" autoplay></video>
<iframe src="https://example.com"></iframe>
<button data-seconds="9999" onclick="alert(1)">forged</button>
<p id="tauri" style="background: url(asset://localhost/private)">[03:25]</p>
`);
    expect(fragment.querySelector("script, img, video, iframe, [onclick], [onerror], [style], [id]")).toBeNull();
    const buttons = fragment.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].dataset.seconds).toBe("205");
  });

  it("only leaves absolute HTTP(S) links usable", () => {
    const fragment = renderSummary('<a href="javascript:alert(1)">bad</a> <a href="asset://localhost/file">local</a> <a href="/relative">relative</a> <a href="https://example.com/notes">safe</a>');
    const links = Array.from(fragment.querySelectorAll<HTMLAnchorElement>("a[href]"));
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe("https://example.com/notes");
    expect(links[0].rel).toBe("noopener noreferrer");
  });
});

describe("timestamp action", () => {
  it("dispatches clicks, highlights playback time without replacing buttons, and cleans up", () => {
    const node = document.createElement("div");
    document.body.append(node);
    const onTimestamp = vi.fn();
    const options = { markdown: "[00:00] 시작 [03:25] 개념", currentTime: 0, onTimestamp, onLink: vi.fn() };
    const action = summaryMarkdown(node, options);
    const buttons = node.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons[0].getAttribute("aria-current")).toBe("true");
    buttons[1].focus();
    buttons[1].click();
    expect(onTimestamp).toHaveBeenCalledWith(205);
    action.update({ ...options, currentTime: 210 });
    expect(node.querySelectorAll("button")[1]).toBe(buttons[1]);
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[0].hasAttribute("aria-current")).toBe(false);
    expect(buttons[1].getAttribute("aria-current")).toBe("true");
    action.destroy();
    buttons[1].click();
    expect(onTimestamp).toHaveBeenCalledOnce();
  });

  it("opens external links through its callback rather than navigating the WebView", () => {
    const node = document.createElement("div");
    const onLink = vi.fn();
    const action = summaryMarkdown(node, {
      markdown: "[자료](https://example.com)", currentTime: 0, onTimestamp: vi.fn(), onLink,
    });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    node.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onLink).toHaveBeenCalledWith("https://example.com/");
    action.destroy();
  });
});
