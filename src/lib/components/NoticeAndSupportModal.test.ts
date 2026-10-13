// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { openUrl } from "@tauri-apps/plugin-opener";
import NoticeAndSupportModal from "./NoticeAndSupportModal.svelte";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
const openUrlMock = vi.mocked(openUrl);
let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
const onclose = vi.fn();

function tab(text: string) {
  return Array.from(target.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((el) =>
    el.textContent?.includes(text),
  )!;
}

beforeEach(() => {
  openUrlMock.mockClear();
  onclose.mockClear();
  target = document.createElement("div");
  document.body.append(target);
  component = mount(NoticeAndSupportModal, { target, props: { onclose } });
  flushSync();
});

afterEach(async () => {
  if (component) await unmount(component);
  document.body.replaceChildren();
});

describe("NoticeAndSupportModal", () => {
  it("does not render any iframe and opens the notice only on click", async () => {
    expect(target.querySelector("iframe")).toBeNull();
    expect(openUrlMock).not.toHaveBeenCalled();
    target.querySelector<HTMLButtonElement>("[data-testid='link-notice']")!.click();
    await vi.waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith("https://h2omol.com/univ-agent-project-notice"),
    );
  });

  it("opens external links through the default browser", async () => {
    tab("프로젝트 소개").click();
    flushSync();
    expect(target.textContent).toContain("Univ-Agent");
    expect(target.querySelector("[data-testid='link-github']")).toBeNull();
    expect(openUrlMock).not.toHaveBeenCalled();
    const extension = target.querySelector<HTMLButtonElement>("[data-testid='link-extension']")!;
    expect(extension.textContent).toBe("강의영상 다운로더 (Chrome 확장프로그램)");
    extension.click();
    await vi.waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith(
        "https://chromewebstore.google.com/detail/hfemchmkjbcnikdmfbipnclbkgomhhkj",
      ),
    );
    openUrlMock.mockClear();
    target.querySelector<HTMLButtonElement>("[data-testid='link-blog']")!.click();
    target.querySelector<HTMLButtonElement>("[data-testid='link-contact']")!.click();
    await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledTimes(2));
    expect(openUrlMock.mock.calls[0][0]).toBe("https://h2omol.com");
    expect(openUrlMock.mock.calls[1][0]).toContain("mailto:jh.chung811@gmail.com");
  });

  it("renders the donation QR card and falls back when the image fails", () => {
    tab("커피").click();
    flushSync();
    const card = target.querySelector("[data-testid='qr-card']")!;
    expect(card.textContent).toContain("스마트폰 카메라나 카카오톡으로 스캔해 주세요");
    expect(card.textContent).toContain("서버 운영비(GPU)");
    const image = card.querySelector<HTMLImageElement>("img.qr-image")!;
    expect(image).not.toBeNull();
    image.dispatchEvent(new Event("error"));
    flushSync();
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector(".qr-fallback")).not.toBeNull();
  });

  it("closes with Escape", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onclose).toHaveBeenCalled();
  });
});
