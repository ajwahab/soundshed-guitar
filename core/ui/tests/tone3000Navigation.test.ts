import { describe, expect, it, vi } from "vitest";
import { findAdjacentTone3000Model, locateTone3000Position } from "../ts/tone3000Navigation";
import type { Tone3000Model, Tone3000Tone } from "../ts/tone3000ApiTypes";

function makeTone(id: string): Tone3000Tone {
  return { id, title: `Tone ${id}` } as Tone3000Tone;
}

function makeModel(id: string): Tone3000Model {
  return { id, name: `Model ${id}`, model_url: `https://tone3000.test/${id}` };
}

/// Result set: two tones of two models each, plus an empty tone in the middle.
const tones = [makeTone("t1"), makeTone("empty"), makeTone("t2")];
const modelsByTone = new Map<string, Tone3000Model[]>([
  ["t1", [makeModel("m1"), makeModel("m2")]],
  ["empty", []],
  ["t2", [makeModel("m3"), makeModel("m4")]],
]);

function makeLoader(): Tone3000ModelLoaderSpy {
  const loaded: string[] = [];
  const loader = vi.fn(async (tone: Tone3000Tone) => {
    loaded.push(String(tone.id));
    return modelsByTone.get(String(tone.id)) ?? [];
  });
  return { loader, loaded };
}

interface Tone3000ModelLoaderSpy {
  loader: (tone: Tone3000Tone) => Promise<Tone3000Model[]>;
  loaded: string[];
}

describe("locateTone3000Position", () => {
  it("locates by tone id", () => {
    expect(locateTone3000Position(tones, modelsByTone, "t2", "m4")).toEqual({ toneIndex: 2, modelId: "m4" });
  });

  it("falls back to searching loaded model lists when the tone id is unknown", () => {
    expect(locateTone3000Position(tones, modelsByTone, "", "m2")).toEqual({ toneIndex: 0, modelId: "m2" });
  });

  it("reports -1 for a resource that is not in the set", () => {
    expect(locateTone3000Position(tones, modelsByTone, "other", "mX").toneIndex).toBe(-1);
  });
});

describe("findAdjacentTone3000Model", () => {
  it("steps within a tone without loading its neighbours", async () => {
    const { loader, loaded } = makeLoader();

    const next = await findAdjacentTone3000Model(tones, { toneIndex: 0, modelId: "m1" }, 1, loader);

    expect(next?.model.id).toBe("m2");
    expect(loaded).toEqual(["t1"]);
  });

  it("continues into the next tone, skipping tones with no models", async () => {
    const { loader, loaded } = makeLoader();

    const next = await findAdjacentTone3000Model(tones, { toneIndex: 0, modelId: "m2" }, 1, loader);

    expect(next?.tone.id).toBe("t2");
    expect(next?.model.id).toBe("m3");
    // Models are fetched only as the walk reaches each tone.
    expect(loaded).toEqual(["t1", "empty", "t2"]);
  });

  it("steps backwards into the end of the previous tone", async () => {
    const { loader } = makeLoader();

    const previous = await findAdjacentTone3000Model(tones, { toneIndex: 2, modelId: "m3" }, -1, loader);

    expect(previous?.tone.id).toBe("t1");
    expect(previous?.model.id).toBe("m2");
  });

  it("wraps around the end of the result set", async () => {
    const { loader } = makeLoader();

    const next = await findAdjacentTone3000Model(tones, { toneIndex: 2, modelId: "m4" }, 1, loader);

    expect(next?.tone.id).toBe("t1");
    expect(next?.model.id).toBe("m1");
  });

  it("enters from the matching end when the current resource is not in the set", async () => {
    const { loader } = makeLoader();

    const forwards = await findAdjacentTone3000Model(tones, { toneIndex: -1, modelId: "" }, 1, loader);
    const backwards = await findAdjacentTone3000Model(tones, { toneIndex: -1, modelId: "" }, -1, loader);

    expect(forwards?.model.id).toBe("m1");
    expect(backwards?.model.id).toBe("m4");
  });

  it("returns null when no tone in the set yields a model", async () => {
    const emptyTones = [makeTone("empty")];
    const loader = vi.fn(async () => [] as Tone3000Model[]);

    const next = await findAdjacentTone3000Model(emptyTones, { toneIndex: 0, modelId: "" }, 1, loader);

    expect(next).toBeNull();
  });
});
