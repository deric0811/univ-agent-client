import DOMPurify from "dompurify";
import { marked } from "marked";

export function timestampSeconds(label: string): number | null {
  const match = /^\[(\d{2,}):([0-5]\d)(?::([0-5]\d))?\]$/.exec(label);
  if (!match) return null;
  const seconds = match[3] === undefined
    ? Number(match[1]) * 60 + Number(match[2])
    : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function renderSummary(markdown: string): DocumentFragment {
  const html = marked.parse(markdown, { async: false, gfm: true });
  // The asset scope allows all local files. Never let model-generated HTML
  // execute scripts, embed files/images, or manufacture our timestamp controls.
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
      "blockquote", "pre", "code", "strong", "em", "del", "table", "thead",
      "tbody", "tr", "th", "td", "a",
    ],
    ALLOWED_ATTR: ["href", "title", "start", "align"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });

  for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>("a")) {
    try {
      const url = new URL(anchor.getAttribute("href") || "");
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsafe link");
      anchor.href = url.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    } catch {
      anchor.removeAttribute("href");
    }
  }

  // Work on text nodes only, never on attributes, code examples, or nested links.
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    if (!text.parentElement?.closest("pre, code, a")) texts.push(text);
  }
  for (const text of texts) {
    const value = text.data;
    const pattern = /\[\d{2,}:[0-5]\d(?::[0-5]\d)?\]/g;
    const replacement = document.createDocumentFragment();
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      const seconds = timestampSeconds(match[0]);
      if (seconds === null) continue;
      replacement.append(document.createTextNode(value.slice(offset, match.index)));
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.seconds = String(seconds);
      button.textContent = match[0];
      button.setAttribute("aria-label", `${match[0]} 시점으로 이동하여 재생`);
      replacement.append(button);
      offset = match.index + match[0].length;
    }
    if (offset > 0) {
      replacement.append(document.createTextNode(value.slice(offset)));
      text.replaceWith(replacement);
    }
  }
  return fragment;
}

interface SummaryOptions {
  markdown: string;
  currentTime: number;
  onTimestamp: (seconds: number) => void;
  onLink: (url: string) => void;
}

// A Svelte action keeps real, keyboard-accessible buttons inside the rendered
// Markdown and owns/cleans up its delegated event handler.
export function summaryMarkdown(node: HTMLElement, initial: SummaryOptions) {
  let options = initial;
  let previousMarkdown: string | undefined;
  let buttons: HTMLButtonElement[] = [];

  function update(next: SummaryOptions) {
    options = next;
    if (previousMarkdown !== options.markdown) {
      node.replaceChildren(renderSummary(options.markdown));
      buttons = Array.from(node.querySelectorAll<HTMLButtonElement>("button[data-seconds]"));
      previousMarkdown = options.markdown;
    }
    // Highlight the latest timestamp reached, without rebuilding HTML or moving focus.
    let active = -1;
    for (const button of buttons) {
      const seconds = Number(button.dataset.seconds);
      if (seconds <= options.currentTime && seconds > active) active = seconds;
    }
    for (const button of buttons) {
      if (Number(button.dataset.seconds) === active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  }

  function onClick(event: MouseEvent) {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-seconds]");
    if (button && node.contains(button)) {
      options.onTimestamp(Number(button.dataset.seconds));
      return;
    }
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (anchor && node.contains(anchor)) {
      event.preventDefault();
      options.onLink(anchor.href);
    }
  }

  update(initial);
  node.addEventListener("click", onClick);
  return {
    update,
    destroy() { node.removeEventListener("click", onClick); },
  };
}
