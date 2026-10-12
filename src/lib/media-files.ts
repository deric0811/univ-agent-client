export interface MediaFile {
  path: string;
  name: string;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

/**
 * 이미 담긴 경로는 건너뛰고 새 파일만 뒤에 추가한다.
 * 빈 문자열/공백 경로는 무시한다.
 */
export function appendMediaFiles(items: MediaFile[], additions: string[]): MediaFile[] {
  const existing = new Set(items.map((item) => item.path));
  const next = [...items];
  for (const rawPath of additions) {
    const path = rawPath.trim();
    if (!path || existing.has(path)) continue;
    existing.add(path);
    next.push({ path, name: fileName(path) });
  }
  return next;
}

/** fromIndex 항목을 toIndex 위치로 옮긴 새 배열을 돌려준다. 범위를 벗어나면 원본을 유지한다. */
export function moveWithin<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items;
  if (fromIndex < 0 || toIndex < 0) return items;
  if (fromIndex >= items.length || toIndex >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
