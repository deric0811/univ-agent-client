const STORAGE_KEY = "univ-agent.session-profile";

export const SCHOOL_DISPLAY_NAME = "고려대 학우님";

export interface SessionProfile {
  displayName: string;
  is_byok: boolean;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 학교 API 키 로그인 성공 시 표시 이름과 BYOK 여부를 저장한다(토큰은 저장하지 않는다). */
export function saveSessionProfile(profile: SessionProfile): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // 저장소를 쓸 수 없으면 이번 세션에서만 유지한다.
  }
}

export function loadSessionProfile(): SessionProfile | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SessionProfile>;
    if (typeof value.displayName !== "string" || !value.displayName.trim()) return null;
    return { displayName: value.displayName, is_byok: value.is_byok === true };
  } catch {
    return null;
  }
}

export function clearSessionProfile(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // 무시
  }
}
