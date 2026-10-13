import { describe, expect, it } from "vitest";
import { appendMediaFiles, fileName, isPptPath, moveWithin, type MediaFile } from "./media-files";

describe("media file helpers", () => {
  it("extracts the base name from Unix and Windows paths", () => {
    expect(fileName("/videos/part 1.mp4")).toBe("part 1.mp4");
    expect(fileName("C:\\Videos\\Part2.mkv")).toBe("Part2.mkv");
    expect(fileName("no-slash")).toBe("no-slash");
  });

  it("appends only new, non-empty paths", () => {
    const first: MediaFile[] = [{ path: "/videos/a.mp4", name: "a.mp4" }];
    const result = appendMediaFiles(first, [
      "/videos/a.mp4",
      "  /videos/b.mp4  ",
      "   ",
      "/videos/c.mp4",
    ]);
    expect(result).toEqual([
      { path: "/videos/a.mp4", name: "a.mp4" },
      { path: "/videos/b.mp4", name: "b.mp4" },
      { path: "/videos/c.mp4", name: "c.mp4" },
    ]);
    // 원본 배열은 변하지 않는다.
    expect(first).toHaveLength(1);
  });

  it("detects PowerPoint files regardless of case", () => {
    expect(isPptPath("/notes/lecture.pptx")).toBe(true);
    expect(isPptPath("C:\\자료\\강의.PPT")).toBe(true);
    expect(isPptPath("/notes/lecture.pdf")).toBe(false);
    expect(isPptPath("/notes/lecture.mp4")).toBe(false);
  });

  it("reorders items and ignores out-of-range moves", () => {
    const items = ["a", "b", "c"];
    expect(moveWithin(items, 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveWithin(items, 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveWithin(items, 1, 1)).toBe(items);
    expect(moveWithin(items, -1, 0)).toBe(items);
    expect(moveWithin(items, 0, 9)).toBe(items);
  });
});
