import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uiState } from "../ts/state.js";
import { backfillTone3000ResourceImages, getTone3000ImageUrl } from "../ts/tone3000Shared.js";
import type { Tone3000Tone } from "../ts/tone3000ApiTypes.js";
import type { LibraryResource } from "../ts/types.js";

type SentMessage = { type?: string; resourceId?: string; metadata?: Record<string, string> };

function makeTone(overrides: Partial<Tone3000Tone>): Tone3000Tone {
  return { id: 1, title: "Tone", ...overrides } as Tone3000Tone;
}

function makeResource(id: string, metadata: Record<string, string>): LibraryResource {
  return { id, name: id, category: "amp", description: "", filePath: `${id}.nam`, metadata };
}

describe("getTone3000ImageUrl", () => {
  it("prefers the first entry of the images array", () => {
    const tone = makeTone({ images: ["https://cdn.test/a.jpg"], image_url: "https://cdn.test/b.jpg" });
    expect(getTone3000ImageUrl(tone)).toBe("https://cdn.test/a.jpg");
  });

  it("falls back through the alternate image fields", () => {
    const tone = makeTone({ images: [], thumbnail_url: "https://cdn.test/thumb.jpg" });
    expect(getTone3000ImageUrl(tone)).toBe("https://cdn.test/thumb.jpg");
  });

  it("ignores values that are not absolute image URLs", () => {
    const tone = makeTone({ images: ["/relative/path.jpg"] });
    expect(getTone3000ImageUrl(tone)).toBeNull();
  });
});

describe("backfillTone3000ResourceImages", () => {
  let sent: SentMessage[] = [];

  beforeEach(() => {
    sent = [];
    window.IPlugSendMsg = (payload: string) => {
      sent.push(JSON.parse(payload) as SentMessage);
    };
    uiState.resourceLibrary = { nam: [], ir: [] };
  });

  afterEach(() => {
    delete window.IPlugSendMsg;
    uiState.resourceLibrary = {};
  });

  it("fills in the tone image for matching resources and persists it", () => {
    const resource = makeResource("tone3000:5", { provider: "tone3000", toneId: "42" });
    uiState.resourceLibrary.nam = [resource];

    backfillTone3000ResourceImages([makeTone({ id: 42, images: ["https://cdn.test/amp.jpg"] })]);

    expect(resource.metadata?.imageUrl).toBe("https://cdn.test/amp.jpg");
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("updateLibraryResource");
    expect(sent[0].resourceId).toBe("tone3000:5");
    // Existing metadata must survive the wholesale replace on the backend.
    expect(sent[0].metadata?.toneId).toBe("42");
  });

  it("leaves resources with existing artwork, other tones, and other providers alone", () => {
    const alreadySet = makeResource("tone3000:1", {
      provider: "tone3000",
      toneId: "42",
      imageUrl: "https://cdn.test/existing.jpg",
    });
    const otherTone = makeResource("tone3000:2", { provider: "tone3000", toneId: "99" });
    const localResource = makeResource("local:3", { provider: "local", toneId: "42" });
    uiState.resourceLibrary.nam = [alreadySet, otherTone, localResource];

    backfillTone3000ResourceImages([makeTone({ id: 42, images: ["https://cdn.test/amp.jpg"] })]);

    expect(alreadySet.metadata?.imageUrl).toBe("https://cdn.test/existing.jpg");
    expect(otherTone.metadata?.imageUrl).toBeUndefined();
    expect(localResource.metadata?.imageUrl).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
