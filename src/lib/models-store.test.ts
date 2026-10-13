import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import {
  FALLBACK_MODELS,
  analysisModeLabel,
  loadModels,
  models,
  parseModels,
  pickDefaultModel,
} from "./models-store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
  models.set(FALLBACK_MODELS);
});

describe("models-store", () => {
  it("stores the fetched model list", async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify([{ id: "a", name: "a", owned_by: "x" }, { id: "a" }, { nope: 1 }]),
    );
    const list = await loadModels();
    expect(list.map((m) => m.id)).toEqual(["a"]);
    expect(get(models)).toEqual(list);
  });

  it("keeps the fallback model when the request fails", async () => {
    invokeMock.mockRejectedValue(new Error("network"));
    await loadModels();
    expect(get(models)).toEqual(FALLBACK_MODELS);
  });

  it("accepts a {data: []} envelope and picks a default", () => {
    const list = parseModels({ data: [{ id: "z" }, { id: "gpt-5.6-luna" }] });
    expect(pickDefaultModel(list)).toBe("gpt-5.6-luna");
    expect(pickDefaultModel([{ id: "z", name: "z" }])).toBe("z");
    expect(pickDefaultModel(list, "z")).toBe("z");
    expect(pickDefaultModel(list, "gone")).toBe("gpt-5.6-luna");
  });

  it("labels analysis modes", () => {
    expect(analysisModeLabel("cheatsheet")).toBe("치트시트");
    expect(analysisModeLabel("unknown")).toBeNull();
  });
});
