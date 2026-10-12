export interface VideoSegment {
  videoPath: string;
  localSeconds: number;
  videoIndex: number;
}

/**
 * 통합 타임스탬프(초)를 개별 영상과 로컬 재생 시점으로 변환한다.
 *
 * - `targetSeconds`가 음수면 0으로, 전체 길이를 넘으면 마지막 영상 끝으로 클램프한다.
 * - 구간 경계값(예: 1부가 정확히 끝나는 시각)은 다음 영상의 0초로 매핑한다.
 * - `durations`가 부족하거나 유효하지 않으면 해당 구간 길이를 0으로 취급한다.
 */
export function resolveVideoSegment(
  targetSeconds: number,
  videoPaths: string[],
  durations: number[],
): VideoSegment {
  if (videoPaths.length === 0) {
    throw new Error("영상 경로가 하나 이상 필요합니다.");
  }

  const safeDurations = videoPaths.map((_, index) => {
    const value = durations[index];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  });
  const total = safeDurations.reduce((sum, value) => sum + value, 0);
  const target = Math.max(0, Math.min(targetSeconds, total));

  let cumulative = 0;
  for (let index = 0; index < videoPaths.length; index += 1) {
    const duration = safeDurations[index];
    const isLast = index === videoPaths.length - 1;
    if (isLast || target < cumulative + duration) {
      return {
        videoPath: videoPaths[index],
        localSeconds: Math.max(0, target - cumulative),
        videoIndex: index,
      };
    }
    cumulative += duration;
  }

  // 위 루프가 항상 반환하지만 TypeScript의 완전성 검사를 위해 유지한다.
  const lastIndex = videoPaths.length - 1;
  return { videoPath: videoPaths[lastIndex], localSeconds: 0, videoIndex: lastIndex };
}
