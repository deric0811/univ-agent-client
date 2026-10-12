import { describe, expect, it } from "vitest";
import { resolveVideoSegment } from "./video-playback";

const paths = ["/videos/part1.mp4", "/videos/part2.mp4"];
const durations = [1200, 1500];

describe("resolveVideoSegment", () => {
  it("maps a timestamp inside the first video", () => {
    expect(resolveVideoSegment(300, paths, durations)).toEqual({
      videoPath: "/videos/part1.mp4",
      localSeconds: 300,
      videoIndex: 0,
    });
  });

  it("maps a timestamp beyond the first video to the second local offset", () => {
    // 25분 30초 = 1530초 → Part 1(1200초)을 넘어 Part 2의 330초(5분 30초)
    expect(resolveVideoSegment(1530, paths, durations)).toEqual({
      videoPath: "/videos/part2.mp4",
      localSeconds: 330,
      videoIndex: 1,
    });
  });

  it("maps zero to the start of the first video", () => {
    expect(resolveVideoSegment(0, paths, durations)).toEqual({
      videoPath: "/videos/part1.mp4",
      localSeconds: 0,
      videoIndex: 0,
    });
  });

  it("maps a segment boundary to the next video start", () => {
    expect(resolveVideoSegment(1200, paths, durations)).toEqual({
      videoPath: "/videos/part2.mp4",
      localSeconds: 0,
      videoIndex: 1,
    });
  });

  it("maps the exact end to the last video end", () => {
    expect(resolveVideoSegment(2700, paths, durations)).toEqual({
      videoPath: "/videos/part2.mp4",
      localSeconds: 1500,
      videoIndex: 1,
    });
  });

  it("clamps out-of-range timestamps", () => {
    expect(resolveVideoSegment(99999, paths, durations)).toEqual({
      videoPath: "/videos/part2.mp4",
      localSeconds: 1500,
      videoIndex: 1,
    });
    expect(resolveVideoSegment(-42, paths, durations)).toEqual({
      videoPath: "/videos/part1.mp4",
      localSeconds: 0,
      videoIndex: 0,
    });
  });

  it("handles a single video", () => {
    expect(resolveVideoSegment(50, ["/videos/only.mp4"], [120])).toEqual({
      videoPath: "/videos/only.mp4",
      localSeconds: 50,
      videoIndex: 0,
    });
  });

  it("treats missing or invalid durations as zero-length segments", () => {
    expect(resolveVideoSegment(10, ["/a.mp4", "/b.mp4"], [0, 60])).toEqual({
      videoPath: "/b.mp4",
      localSeconds: 10,
      videoIndex: 1,
    });
    expect(resolveVideoSegment(10, ["/a.mp4", "/b.mp4"], [])).toEqual({
      videoPath: "/b.mp4",
      localSeconds: 0,
      videoIndex: 1,
    });
  });

  it("requires at least one video path", () => {
    expect(() => resolveVideoSegment(0, [], [])).toThrow();
  });
});
