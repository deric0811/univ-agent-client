import { invoke } from "@tauri-apps/api/core";
import { get, writable } from "svelte/store";

export interface LlmModel {
  id: string;
  name: string;
  owned_by?: string | null;
}

export type AnalysisMode = "summary" | "quiz" | "easy_concept" | "cheatsheet";

export const DEFAULT_MODEL_ID = "gpt-5.6-luna";
export const FALLBACK_MODELS: LlmModel[] = [{ id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_ID }];

export const ANALYSIS_MODE_OPTIONS: { value: AnalysisMode; label: string }[] = [
  { value: "summary", label: "핵심 요약" },
  { value: "quiz", label: "시험 대비 문제" },
  { value: "easy_concept", label: "쉬운 개념 풀이" },
  { value: "cheatsheet", label: "치트시트" },
];

export function analysisModeLabel(mode: unknown): string | null {
  const option = ANALYSIS_MODE_OPTIONS.find((item) => item.value === mode);
  return option ? option.label : null;
}

/** 마지막 모델 목록 조회 실패 메시지(성공하면 null). */
export const modelsError = writable<string | null>(null);

export const models = writable<LlmModel[]>(FALLBACK_MODELS);

export function parseModels(value: unknown): LlmModel[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : [];
  const result: LlmModel[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim() || seen.has(record.id)) continue;
    seen.add(record.id);
    result.push({
      id: record.id,
      name: typeof record.name === "string" && record.name ? record.name : record.id,
      owned_by: typeof record.owned_by === "string" ? record.owned_by : null,
    });
  }
  return result;
}

/** 서버에서 모델 목록을 불러와 스토어에 보관한다. 실패하면 기본 모델로 유지한다. */
export async function loadModels(): Promise<LlmModel[]> {
  try {
    const parsed = parseModels(JSON.parse(await invoke<string>("list_models")));
    models.set(parsed.length > 0 ? parsed : FALLBACK_MODELS);
    modelsError.set(null);
  } catch (error) {
    models.set(FALLBACK_MODELS);
    modelsError.set(error instanceof Error ? error.message : String(error));
  }
  return get(models);
}

/** 목록에 있는 기본 모델(없으면 첫 번째)을 고른다. */
export function pickDefaultModel(list: LlmModel[], current = ""): string {
  if (current && list.some((item) => item.id === current)) return current;
  return (list.find((item) => item.id === DEFAULT_MODEL_ID) ?? list[0] ?? FALLBACK_MODELS[0]).id;
}
