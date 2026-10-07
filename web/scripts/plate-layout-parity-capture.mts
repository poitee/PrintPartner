import { Buffer } from "node:buffer";
import {
  LEGACY_ACCEPTED_PLATE_LAYOUT_FORMAT,
  layoutDigest,
  validatePlates,
} from "../apps/server/src/db/accepted-plate-layout-model.ts";
import {
  acceptedPrinter,
  initializeAcceptedPlates,
} from "../apps/server/src/services/accepted-plate-workspace.ts";
import { productionPackingBuckets } from "../apps/server/src/services/production-packing-rules.ts";
import {
  packAcceptedUnits,
  packAcceptedUnitsAround,
} from "../packages/domain/src/accepted-plate-packer.ts";
import {
  parseAcceptedStlMesh,
  stlMeshDimensionsUm,
} from "../packages/domain/src/stl-mesh.ts";

const tokenA = `ppu_${"a".repeat(32)}`;
const tokenB = `ppu_${"b".repeat(32)}`;
const tokenC = `ppu_${"c".repeat(32)}`;
const basis = {
  profileId: 1,
  planVersion: 2,
  revisionId: 3,
  revisionDigest: "a".repeat(64),
  requiredUnitMappingDigest: "b".repeat(64),
};
const printer = {
  bedWidthUm: 120,
  bedDepthUm: 100,
  bedHeightUm: 80,
  marginUm: 10,
};

const validated = validatePlates([
  {
    plateId: `plate_${"a".repeat(32)}`,
    printerId: "\ufeffprinter\ufeff",
    printerName: `\ufeff${"é".repeat(200)}\ufeff`,
    printerModel: " Mødel 😺 ",
    ...printer,
    units: [
      {
        token: tokenA,
        xUm: 10,
        yUm: 10,
        widthUm: 30,
        depthUm: 20,
        heightUm: 10,
        placement: "auto" as const,
        pinned: true,
      },
    ],
  },
], new Set([tokenA]));
if (validated.kind !== "ready") throw new Error(`layout validation failed: ${JSON.stringify(validated)}`);

const packingUnits = [
  { token: tokenC, widthUm: 30, depthUm: 20, heightUm: 10 },
  { token: tokenA, widthUm: 50, depthUm: 30, heightUm: 10 },
  { token: tokenB, widthUm: 40, depthUm: 40, heightUm: 10 },
];
const packed = packAcceptedUnits({ printer, units: packingUnits });
const around = packAcceptedUnitsAround({
  printer,
  occupied: [{ token: tokenA, widthUm: 30, depthUm: 20, heightUm: 10, xUm: 40, yUm: 40 }],
  units: [
    { token: tokenB, widthUm: 30, depthUm: 20, heightUm: 10 },
    { token: tokenC, widthUm: 50, depthUm: 30, heightUm: 10 },
  ],
});

const grouped = productionPackingBuckets([
  { token: tokenA, objectName: "ä", filename: "a.stl", sourceDirectory: "XY", sourceLayer: "base", role: "primary", filamentColorId: "\ufeff", filamentCustomHex: "#FF6600" },
  { token: tokenB, objectName: "b", filename: "b.stl", sourceDirectory: "XY", sourceLayer: "base", role: "primary", filamentColorId: null, filamentCustomHex: "ff6600" },
  { token: tokenC, objectName: "c", filename: "c.stl", sourceDirectory: "skirts", sourceLayer: "base", role: "accent", filamentColorId: "green" },
], [
  { id: "xy-abs", enabled: true, kind: "set_material", field: "source_directory", value: "XY", material_type: "ABS" },
  { id: "materials", enabled: true, kind: "separate_by", field: "material" },
  { id: "orange", enabled: true, kind: "keep_together", field: "color", value: "#ff6600" },
]).map((bucket) => bucket.map((unit) => unit.token));

let publishedPlates: readonly { plateId: string }[] | undefined;
const setupUnit = {
  token: tokenA,
  partId: null,
  objectName: `part__${tokenA}`,
  filename: "part.stl",
  relativePath: "parts/part.stl",
  sourceDirectory: "parts",
  sourceLayer: "base",
  role: "primary",
  filamentColorId: "black",
  artifact: { kind: "unavailable" as const, reason: "untracked_source" as const },
};
const setupUnitB = {
  ...setupUnit,
  token: tokenB,
  objectName: `part-b__${tokenB}`,
  filename: "part-b.stl",
};
await initializeAcceptedPlates({
  repository: {
    readAcceptedPlateWorkspaceInput: () => ({
      kind: "setup" as const,
      basis,
      expectedPlateRevisionId: null,
      units: [setupUnit, setupUnitB],
    }),
    publishAcceptedPlates: (command) => {
      publishedPlates = command.plates;
      return { kind: "published" as const, plateRevisionId: 1, plateRevisionNumber: 1 };
    },
    getSetting: () => null,
  },
  reposDir: "/unused",
  limits: { maxArtifactBytes: 1, maxTotalSourceBytes: 1, maxObjects: 1, maxTriangles: 1 },
  loadPrinters: () => [{
    id: "printer",
    name: "Printer",
    model: "Model",
    bed_width_mm: 0.12,
    bed_depth_mm: 0.10,
    bed_height_mm: 0.08,
    margin_mm: 0.01,
    max_filament_slots: 1,
    loaded_filaments: [],
  }],
  loadGeometry: async () => ({
    kind: "ready" as const,
    geometryByToken: new Map([
      [tokenA, { dimensions: { widthUm: 30, depthUm: 20, heightUm: 10 } }],
      [tokenB, { dimensions: { widthUm: 30, depthUm: 20, heightUm: 10 } }],
    ]),
  }),
}, {
  profileId: 1,
  expected: basis,
  expectedPlateRevisionId: null,
  assignments: [
    { token: tokenB, printerId: "printer" },
    { token: tokenA, printerId: "printer" },
  ],
});
if (!publishedPlates?.[0]) throw new Error("initializer did not publish a Plate");

const ascii = Buffer.from(`solid dimensions
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 0.0014 0 0
vertex 0 0.0026 0.0035
endloop
endfacet
endsolid dimensions`);
const mesh = parseAcceptedStlMesh(ascii);
if (!mesh) throw new Error("actual accepted STL parser rejected the golden mesh");
const nonfiniteNormal = parseAcceptedStlMesh(Buffer.from(`solid accepted
facet normal 1e999 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 1
endloop
endfacet
endsolid accepted`));
const invalidUtf8Header = Buffer.concat([
  Buffer.from("solid "),
  Buffer.from([0xff]),
  ascii.subarray(ascii.indexOf("\n")),
]);
const binaryWithExtraByte = Buffer.alloc(135);
binaryWithExtraByte.writeUInt32LE(1, 80);

const facetBody = `facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 1
endloop
endfacet`;
const stlEnvelopes = [
  ["validLf", `solid a\n${facetBody}\nendsolid a`],
  ["validCrLf", `solid a\r\n${facetBody.replaceAll("\n", "\r\n")}\r\nendsolid a`],
  ["oneNewlineLf", "solid a\nendsolid a"],
  ["oneNewlineCrLf", "solid a\r\nendsolid a"],
  ["headerEmbeddedCr", `solid a\rb\n${facetBody}\nendsolid a`],
  ["headerDoubleCr", `solid a\r\r\n${facetBody}\nendsolid a`],
  ["footerEmbeddedCr", `solid a\n${facetBody}\nendsolid a\rb`],
  ["footerTrailingCrCr", `solid a\n${facetBody}\nendsolid a\r\r`],
] as const;
const envelopeResults = stlEnvelopes.map(([name, text]) => {
  const bytes = Buffer.from(text);
  return {
    name,
    hex: bytes.toString("hex"),
    accepted: parseAcceptedStlMesh(bytes) !== null,
  };
});

const dimensionCases = [
  ["roundsBelowHalfToZero", 0.0004999],
  ["roundsHalfUp", 0.0005],
  ["layoutMaximum", 2_147_483.647],
  ["layoutMaximumPlusOne", 2_147_483.648],
  ["largestRepresentableSafeBelowLimit", 9_007_199_254_740.99],
  ["nextRepresentableAboveLimit", 9_007_199_254_740.992],
] as const;
const dimensionResults = dimensionCases.map(([name, widthMm]) => ({
  name,
  widthMm,
  dimensions: stlMeshDimensionsUm({
    ...mesh,
    bounds: {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: widthMm,
      maxY: 1,
      maxZ: 1,
      widthMm,
      depthMm: 1,
      heightMm: 1,
    },
  }),
}));

const acceptedMachine = acceptedPrinter({
  id: " printer ",
  name: " Printer ",
  model: " Model ",
  bed_width_mm: 0.12,
  bed_depth_mm: 0.10,
  bed_height_mm: 0.08,
  margin_mm: 0.01,
  max_filament_slots: 1,
  loaded_filaments: [],
});
const rejectedFractionalMachine = acceptedPrinter({
  id: "printer",
  name: "Printer",
  model: "Model",
  bed_width_mm: 0.1201,
  bed_depth_mm: 0.10,
  bed_height_mm: 0.08,
  margin_mm: 0.01,
  max_filament_slots: 1,
  loaded_filaments: [],
});

process.stdout.write(`${JSON.stringify({
  layout: {
    format1: layoutDigest(validated.plates, LEGACY_ACCEPTED_PLATE_LAYOUT_FORMAT),
    format2: layoutDigest(validated.plates),
    normalizedPrinterNameLength: validated.plates[0]?.printerName.length,
  },
  initialPlateId: publishedPlates[0].plateId,
  packed,
  around,
  grouped,
  printerConversion: {
    accepted: acceptedMachine,
    fractionalRejected: rejectedFractionalMachine === null,
  },
  stl: {
    dimensions: stlMeshDimensionsUm(mesh),
    envelopes: envelopeResults,
    dimensionCases: dimensionResults,
    binaryExtraRejected: parseAcceptedStlMesh(binaryWithExtraByte) === null,
    truncatedRejected: parseAcceptedStlMesh(Buffer.from("solid incomplete\nvertex 0 0 0")) === null,
    nonfiniteNormalAccepted: nonfiniteNormal !== null,
    invalidUtf8HeaderAccepted: parseAcceptedStlMesh(invalidUtf8Header) !== null,
  },
}, null, 2)}\n`);
