// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MediaFileList from "./MediaFileList.svelte";

let component: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(onmove = vi.fn(), onremove = vi.fn(), onreorder = vi.fn(), onadd = vi.fn()) {
  const target = document.createElement("div");
  document.body.append(target);
  component = mount(MediaFileList, {
    target,
    props: {
      items: [
        { path: "/videos/part1.mp4", name: "part1.mp4" },
        { path: "/videos/part2.mp4", name: "part2.mp4" },
      ],
      heading: "강의 영상",
      hint: "여러 개 선택 시 순서대로 이어 붙입니다.",
      addLabel: "영상 파일 추가",
      emptyText: "영상이 없습니다.",
      onadd,
      onremove,
      onmove,
      onreorder,
    },
  });
  return { target, onmove, onremove, onreorder, onadd };
}

describe("MediaFileList", () => {
  it("renders numbered items with disabled boundary move buttons", () => {
    const { target } = render();
    const items = target.querySelectorAll(".media-list li");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(".name")?.textContent).toBe("part1.mp4");

    const firstUp = items[0].querySelector<HTMLButtonElement>('button[aria-label="part1.mp4 위로 이동"]')!;
    const firstDown = items[0].querySelector<HTMLButtonElement>('button[aria-label="part1.mp4 아래로 이동"]')!;
    const lastDown = items[1].querySelector<HTMLButtonElement>('button[aria-label="part2.mp4 아래로 이동"]')!;
    expect(firstUp.disabled).toBe(true);
    expect(firstDown.disabled).toBe(false);
    expect(lastDown.disabled).toBe(true);
  });

  it("reports add, move and remove actions", () => {
    const onmove = vi.fn();
    const onremove = vi.fn();
    const onreorder = vi.fn();
    const onadd = vi.fn();
    const { target } = render(onmove, onremove, onreorder, onadd);

    target.querySelector<HTMLButtonElement>(".media-heading button")!.click();
    expect(onadd).toHaveBeenCalledTimes(1);

    target
      .querySelector<HTMLButtonElement>('button[aria-label="part1.mp4 아래로 이동"]')!
      .click();
    expect(onmove).toHaveBeenCalledWith(0, 1);

    target.querySelector<HTMLButtonElement>('button[aria-label="part2.mp4 제거"]')!.click();
    expect(onremove).toHaveBeenCalledWith(1);
  });

  it("reorders items through HTML5 drag and drop", () => {
    const onmove = vi.fn();
    const onremove = vi.fn();
    const onreorder = vi.fn();
    const onadd = vi.fn();
    const { target } = render(onmove, onremove, onreorder, onadd);
    const items = target.querySelectorAll<HTMLLIElement>(".media-list li");

    items[0].dispatchEvent(new Event("dragstart", { bubbles: true }));
    items[1].dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    flushSync();
    expect(items[1].classList.contains("drag-over")).toBe(true);

    items[1].dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    flushSync();
    expect(onreorder).toHaveBeenCalledWith(0, 1);
    expect(items[1].classList.contains("drag-over")).toBe(false);

    items[1].dispatchEvent(new Event("dragend", { bubbles: true }));
  });

  it("toggles the info badge tooltip on click", () => {
    const target = document.createElement("div");
    document.body.append(target);
    component = mount(MediaFileList, {
      target,
      props: {
        items: [],
        heading: "교안 PDF",
        hint: "hint",
        addLabel: "PDF 파일 추가",
        emptyText: "PDF가 없습니다.",
        badgeLabel: "PDF 전용",
        badgeTooltip: "교안 파일은 PDF 형식만 지원합니다.",
        onadd: vi.fn(),
        onremove: vi.fn(),
        onmove: vi.fn(),
        onreorder: vi.fn(),
      },
    });
    const badge = target.querySelector<HTMLButtonElement>(".info-badge");
    expect(badge?.textContent).toContain("PDF 전용");
    expect(badge?.getAttribute("title")).toBe("교안 파일은 PDF 형식만 지원합니다.");

    badge!.click();
    flushSync();
    expect(target.querySelector(".info-tip")?.textContent).toBe(
      "교안 파일은 PDF 형식만 지원합니다.",
    );
    badge!.click();
    flushSync();
    expect(target.querySelector(".info-tip")).toBeNull();
  });

  it("shows the empty state when there are no items", () => {
    const target = document.createElement("div");
    document.body.append(target);
    component = mount(MediaFileList, {
      target,
      props: {
        items: [],
        heading: "교안 PDF",
        hint: "hint",
        addLabel: "PDF 파일 추가",
        emptyText: "PDF가 없습니다.",
        onadd: vi.fn(),
        onremove: vi.fn(),
        onmove: vi.fn(),
        onreorder: vi.fn(),
      },
    });
    expect(target.querySelector(".media-list")).toBeNull();
    expect(target.querySelector(".empty")?.textContent).toBe("PDF가 없습니다.");
  });
});
