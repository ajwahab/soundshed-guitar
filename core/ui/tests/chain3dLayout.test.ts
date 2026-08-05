import { describe, expect, it } from "vitest";
import {
  cabinetCountForCabNode,
  countLoadedResources,
  resolveCabinetCount,
} from "../ts/amp3d/chainCabRules.js";
import { buildChainLayout, collectChainLanes } from "../ts/amp3d/chainLayout.js";
import {
  isSignalChain3dEnabled,
  setSignalChain3dEnabled,
  SIGNAL_CHAIN_3D_SETTING,
  NEURAL_AMP_3D_SETTING,
} from "../ts/amp3d/ampSupport.js";
import { uiState } from "../ts/state.js";

describe("chainCabRules", () => {
  it("counts loaded resources from id/filePath", () => {
    expect(countLoadedResources({
      id: "c",
      type: "cab",
      resources: [{ id: "a" }, { filePath: "x.wav" }, {}],
    })).toBe(2);
  });

  it("caps cabinet count at 2", () => {
    expect(cabinetCountForCabNode({
      id: "c",
      type: "cab",
      resources: [{ id: "1" }, { id: "2" }, { id: "3" }],
    })).toBe(2);
  });

  it("resolves full-rig amp without cab to 1 cabinet", () => {
    expect(resolveCabinetCount({ hasAmp: true, ampIsFullRig: true, cabNode: null })).toBe(1);
  });

  it("uses IR count when cab present", () => {
    expect(resolveCabinetCount({
      hasAmp: true,
      ampIsFullRig: false,
      cabNode: { id: "c", type: "cab", resources: [{ id: "a" }, { id: "b" }] },
    })).toBe(2);
  });
});

describe("chainLayout", () => {
  it("clusters amp + cab, hides utilities, and clears dual-cab width", () => {
    const layout = buildChainLayout({
      graph: {
        nodes: [
          { id: "drive", type: "delay_digital", displayName: "Delay" },
          { id: "amp", type: "amp_nam", displayName: "Amp" },
          { id: "cab", type: "cab_ir", displayName: "Cab", resources: [{ id: "ir1" }, { id: "ir2" }] },
          { id: "split", type: "splitter", displayName: "Split" },
          { id: "a", type: "reverb_room", displayName: "A" },
          { id: "b", type: "reverb_room", displayName: "B" },
          { id: "mix", type: "mixer", displayName: "Mix" },
          { id: "post", type: "eq_parametric", displayName: "Post EQ" },
        ],
        edges: [
          { from: "__input__", to: "drive" },
          { from: "drive", to: "amp" },
          { from: "amp", to: "cab" },
          { from: "cab", to: "split" },
          { from: "split", to: "a", fromPort: 0 },
          { from: "split", to: "b", fromPort: 1 },
          { from: "a", to: "mix" },
          { from: "b", to: "mix" },
          { from: "mix", to: "post" },
          { from: "post", to: "__output__" },
        ],
      },
      fullRigByNodeId: { amp: false },
      resolveType: (t) => t,
      ampTypeIds: ["amp_nam"],
      cabTypeIds: ["cab_ir"],
      pedalTypeIds: ["fx_nam"],
      junctionTypeIds: ["splitter", "mixer"],
    });

    const ampUnit = layout.units.find((u) => u.nodeId === "amp");
    expect(ampUnit?.kind).toBe("amp_cab_cluster");
    expect(ampUnit?.cabinetCount).toBe(2);
    expect(ampUnit?.pairedNodeId).toBe("cab");

    // Utility split/mix are not 3D products.
    expect(layout.anchors.some((a) => a.nodeId === "split")).toBe(false);
    expect(layout.anchors.some((a) => a.nodeId === "mix")).toBe(false);
    expect(layout.units.some((u) => u.nodeId === "split" || u.nodeId === "mix")).toBe(false);

    // Dual-cab clusters need wide X advance so neighbouring racks clear both cabs.
    // Linear chain: pre-fx → dual amp/cab → post-fx on the same trunk progression.
    const linear = buildChainLayout({
      graph: {
        nodes: [
          { id: "pre", type: "dynamics_gate", displayName: "Gate" },
          { id: "amp", type: "amp_nam", displayName: "Amp" },
          { id: "cab", type: "cab_ir", displayName: "Cab", resources: [{ id: "ir1" }, { id: "ir2" }] },
          { id: "post", type: "eq_parametric", displayName: "EQ" },
        ],
        edges: [
          { from: "__input__", to: "pre" },
          { from: "pre", to: "amp" },
          { from: "amp", to: "cab" },
          { from: "cab", to: "post" },
          { from: "post", to: "__output__" },
        ],
      },
      fullRigByNodeId: { amp: false },
      resolveType: (t) => t,
      ampTypeIds: ["amp_nam"],
      cabTypeIds: ["cab_ir"],
    });
    const ampAnchor = linear.anchors.find((a) => a.nodeId === "amp");
    const postAnchor = linear.anchors.find((a) => a.nodeId === "post");
    expect(ampAnchor).toBeTruthy();
    expect(postAnchor).toBeTruthy();
    if (ampAnchor && postAnchor) {
      expect(postAnchor.x - ampAnchor.x).toBeGreaterThanOrEqual(2.0);
    }

    const lanes = collectChainLanes({
      nodes: [
        { id: "drive", type: "delay_digital" },
        { id: "amp", type: "amp_nam" },
        { id: "cab", type: "cab_ir" },
        { id: "split", type: "splitter" },
        { id: "a", type: "reverb_room" },
        { id: "b", type: "reverb_room" },
        { id: "mix", type: "mixer" },
        { id: "post", type: "eq_parametric" },
      ],
      edges: [
        { from: "__input__", to: "drive" },
        { from: "drive", to: "amp" },
        { from: "amp", to: "cab" },
        { from: "cab", to: "split" },
        { from: "split", to: "a", fromPort: 0 },
        { from: "split", to: "b", fromPort: 1 },
        { from: "a", to: "mix" },
        { from: "b", to: "mix" },
        { from: "mix", to: "post" },
        { from: "post", to: "__output__" },
      ],
    });
    expect(lanes.some((l) => l.laneIndex === 1)).toBe(true);
    expect(layout.anchors.some((a) => a.nodeId === "a")).toBe(true);
    expect(layout.anchors.some((a) => a.nodeId === "b")).toBe(true);
  });

  it("maps neural fx to pedal kind", () => {
    const layout = buildChainLayout({
      graph: {
        nodes: [{ id: "fx", type: "fx_nam", displayName: "Neural FX" }],
        edges: [
          { from: "__input__", to: "fx" },
          { from: "fx", to: "__output__" },
        ],
      },
      resolveType: (t) => t,
      pedalTypeIds: ["fx_nam"],
    });
    expect(layout.units[0]?.kind).toBe("pedal");
  });

  it("stacks consecutive rack effects into one chassis", () => {
    const layout = buildChainLayout({
      graph: {
        nodes: [
          { id: "gate", type: "dynamics_gate", displayName: "Gate", category: "dynamics" },
          { id: "eq", type: "eq_parametric", displayName: "EQ", category: "eq" },
          { id: "delay", type: "delay_digital", displayName: "Delay", category: "delay" },
          { id: "reverb", type: "reverb_room", displayName: "Reverb", category: "reverb" },
        ],
        edges: [
          { from: "__input__", to: "gate" },
          { from: "gate", to: "eq" },
          { from: "eq", to: "delay" },
          { from: "delay", to: "reverb" },
          { from: "reverb", to: "__output__" },
        ],
      },
      resolveType: (t) => t,
    });

    expect(layout.units).toHaveLength(1);
    expect(layout.units[0]?.kind).toBe("rack_stack");
    expect(layout.units[0]?.rackUnitCount).toBe(12);
    expect(layout.units[0]?.stack?.map((s) => s.nodeId)).toEqual([
      "gate",
      "eq",
      "delay",
      "reverb",
    ]);
    // All stack members share the same X anchor (vertical stack, not floor row).
    const xs = ["gate", "eq", "delay", "reverb"].map(
      (id) => layout.anchors.find((a) => a.nodeId === id)?.x,
    );
    expect(new Set(xs).size).toBe(1);
    // Signal order fills top → bottom (first FX highest Y).
    const ys = ["gate", "eq", "delay", "reverb"].map(
      (id) => layout.anchors.find((a) => a.nodeId === id)?.y ?? -1,
    );
    expect(ys[0]).toBeGreaterThan(ys[1]!);
    expect(ys[1]).toBeGreaterThan(ys[2]!);
    expect(ys[2]).toBeGreaterThan(ys[3]!);
  });

  it("omits input analyzer utility from 3d units", () => {
    const layout = buildChainLayout({
      graph: {
        nodes: [
          { id: "ana", type: "input_analyzer", displayName: "Analyzer" },
          { id: "eq", type: "eq_parametric", displayName: "EQ" },
        ],
        edges: [
          { from: "__input__", to: "ana" },
          { from: "ana", to: "eq" },
          { from: "eq", to: "__output__" },
        ],
      },
      resolveType: (t) => t,
      utilityTypeIds: ["input_analyzer"],
    });
    expect(layout.units.map((u) => u.nodeId)).toEqual(["eq"]);
    expect(layout.anchors.some((a) => a.nodeId === "ana")).toBe(false);
  });
});

describe("signalChain3d setting migration", () => {
  it("migrates legacy neural amp 3d setting on read", () => {
    uiState.appSettings = { [NEURAL_AMP_3D_SETTING]: true };
    expect(isSignalChain3dEnabled()).toBe(true);
    expect(uiState.appSettings?.[SIGNAL_CHAIN_3D_SETTING]).toBe(true);
    setSignalChain3dEnabled(false);
    expect(isSignalChain3dEnabled()).toBe(false);
  });
});
