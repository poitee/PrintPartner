import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import PartThumb from "../../src/components/parts/PartThumb";
import Preview3D from "../../src/components/Preview3D";

const title = "Thumbnail regression fixture — no Build data";
const stallFirstCapture = new URLSearchParams(location.search).get("capture") === "stall";
const startedAt = performance.now();
const parts = Array.from({ length: 12 }, (_, index) => ({
  id: 900_001 + index,
  label: `Fixture ${index + 1}: ${index % 2 === 0 ? "Black" : "Super Grey"}`,
  hex: index % 2 === 0 ? "#000000" : "#747874",
  meshBasis: ((900_001 + index) * 2).toString(16).padStart(64, "0"),
  thumbnailBasis: ((900_001 + index) * 2 + 1).toString(16).padStart(64, "0"),
  width: 16 + index,
  depth: 12 + (index % 4) * 2,
  height: 8 + (index % 3) * 4,
}));

function mesh(part: (typeof parts)[number]): string {
  const { width: x, depth: y, height: z } = part;
  const vertices = [
    [0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0],
    [0, 0, z], [x, 0, z], [x, y, z], [0, y, z],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  return `solid fixture-${part.id}\n${faces.map((face) =>
    `facet normal 0 0 0\nouter loop\n${face.map((index) =>
      `vertex ${vertices[index].join(" ")}`).join("\n")}\nendloop\nendfacet`,
  ).join("\n")}\nendsolid fixture-${part.id}`;
}

const thumbnails = new Map<number, Blob>();
let counters = { uploads: 0, cached: 0, stalledCaptures: 0, unexpectedRequests: 0 };
const listeners = new Set<() => void>();
function updateCounters(update: Partial<typeof counters>): void {
  counters = { ...counters, ...update };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Every fetch stays in this document. Unknown routes fail instead of reaching an app server.
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const request = new Request(input, init);
  const route = /\/parts\/(\d+)\/(mesh|thumbnail|preview)$/.exec(new URL(request.url).pathname);
  const part = route ? parts.find((candidate) => candidate.id === Number(route[1])) : undefined;
  if (!route || !part) {
    updateCounters({ unexpectedRequests: counters.unexpectedRequests + 1 });
    return Response.json({ detail: "Not a fixture media endpoint" }, { status: 404 });
  }
  if (request.method === "GET" && route[2] === "mesh") {
    return new Response(mesh(part), {
      headers: {
        "Content-Type": "model/stl",
        ETag: `"${part.meshBasis}"`,
        "X-Accepted-Render-Hex": part.hex,
      },
    });
  }
  if (request.method === "POST" && route[2] === "thumbnail") {
    updateCounters({ uploads: counters.uploads + 1 });
    const form = await request.formData();
    const png = form.get("file");
    if (!(png instanceof Blob) || png.type !== "image/png" ||
        request.headers.get("If-Match") !== `"${part.meshBasis}"`) {
      return Response.json({ detail: "Expected a PNG for this fixture mesh" }, { status: 400 });
    }
    thumbnails.set(part.id, png);
    updateCounters({ cached: thumbnails.size });
    return Response.json({ saved: true, digest: part.thumbnailBasis });
  }
  if (request.method === "GET" && route[2] === "thumbnail") {
    const png = thumbnails.get(part.id);
    if (!png) {
      return new Response(null, { headers: { "X-Thumbnail-Placeholder": "1" } });
    }
    const headers = {
      "Content-Type": "image/png",
      ETag: `"${part.thumbnailBasis}"`,
      "X-Accepted-Render-Hex": part.hex,
    };
    return request.headers.get("If-None-Match") === headers.ETag
      ? new Response(null, { status: 304, headers })
      : new Response(png, { headers });
  }
  return Response.json({ detail: "Unsupported fixture media operation" }, { status: 404 });
};

const originalToBlob = HTMLCanvasElement.prototype.toBlob;
if (stallFirstCapture) {
  HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
    if (counters.stalledCaptures === 0) {
      updateCounters({ stalledCaptures: 1 });
      return;
    }
    originalToBlob.call(this, callback, type, quality);
  };
}

type Sample = { id: number; status: "waiting" | "pass" | "fail"; detail: string };
function sample(image: HTMLImageElement, part: (typeof parts)[number]): Sample {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return { id: part.id, status: "fail", detail: "No pixel reader" };
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const totals = [0, 0, 0];
  let opaque = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] < 250) continue;
    opaque += 1;
    for (let channel = 0; channel < 3; channel += 1) totals[channel] += data[offset + channel];
  }
  const rgb = totals.map((value) => opaque === 0 ? 0 : value / opaque);
  const colorCorrect = part.hex === "#000000"
    ? Math.max(...rgb) < 40
    : Math.min(...rgb) > 40 && Math.max(...rgb) - Math.min(...rgb) < 10;
  const pass = canvas.width === 256 && canvas.height === 256 && opaque > 500 && colorCorrect;
  return {
    id: part.id,
    status: pass ? "pass" : "fail",
    detail: `${canvas.width} × ${canvas.height}; ${opaque} opaque pixels; RGB ${rgb.map(Math.round).join(", ")}`,
  };
}

function Fixture() {
  const counts = useSyncExternalStore(subscribe, () => counters);
  const grid = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [completedIn, setCompletedIn] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBaseline, setPreviewBaseline] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((performance.now() - startedAt) / 1000), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const node = grid.current;
    if (!node) return;
    const measured = new WeakMap<HTMLImageElement, { src: string; result: Sample }>();
    let signature = "";
    const scan = () => {
      const next = parts.map((part): Sample => {
        const image = node.querySelector<HTMLImageElement>(`[data-part="${part.id}"] img.sheet-thumb-img`);
        if (!image?.complete || image.naturalWidth <= 1) {
          return { id: part.id, status: "waiting", detail: "Waiting for image" };
        }
        const previous = measured.get(image);
        if (previous?.src === image.src) return previous.result;
        let result: Sample;
        try {
          result = sample(image, part);
        } catch (error) {
          result = { id: part.id, status: "fail", detail: String(error) };
        }
        measured.set(image, { src: image.src, result });
        return result;
      });
      const nextSignature = JSON.stringify(next);
      if (signature !== nextSignature) {
        signature = nextSignature;
        setSamples(next);
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    node.addEventListener("load", scan, true);
    scan();
    return () => { observer.disconnect(); node.removeEventListener("load", scan, true); };
  }, [generation]);

  const loaded = samples.filter((entry) => entry.status !== "waiting").length;
  const passed = samples.filter((entry) => entry.status === "pass").length;
  const ready = passed === parts.length && counts.cached === parts.length;
  useEffect(() => {
    if (ready && completedIn === null) setCompletedIn((performance.now() - startedAt) / 1000);
  }, [ready, completedIn]);
  const previewWrites = previewBaseline === null ? 0 : counts.uploads - previewBaseline;
  const failed = samples.some((entry) => entry.status === "fail") || counts.unexpectedRequests > 0 ||
    previewWrites > 0 || (completedIn === null ? !ready && elapsed > 15 : completedIn > 15);
  const buttonStyle = { padding: "8px 14px", border: "1px solid var(--border)", borderRadius: 6 };

  return (
    <main style={{ maxWidth: 1020, padding: 24, margin: "0 auto" }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>{title}</h1>
      <p>12 distinct meshes. All media requests and uploads stay in this page’s memory.</p>
      <p>{stallFirstCapture ? "Fault mode: the first canvas capture callback is deliberately withheld." : "Normal capture mode."}</p>
      <p role="status" data-result={failed ? "fail" : ready ? "pass" : "loading"} style={{ margin: "16px 0" }}>
        {failed ? "FAIL" : ready ? "PASS" : "Loading"}: {loaded}/12 images loaded; {passed}/12 pixel checks passed.
        {" "}Thumbnail POSTs: {counts.uploads}. Cached: {counts.cached}. Stalled captures: {counts.stalledCaptures}.
        {" "}Unexpected requests: {counts.unexpectedRequests}. Elapsed: {elapsed.toFixed(1)}s.
        {completedIn === null ? "" : ` First complete: ${completedIn.toFixed(1)}s.`}
      </p>
      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <button style={buttonStyle} disabled={!ready} onClick={() => {
          setPreviewBaseline(counts.uploads);
          setPreviewOpen(true);
        }}>Open grey preview</button>
        <button style={buttonStyle} disabled={!ready} onClick={() => setGeneration((value) => value + 1)}>
          Reload thumbnail cards
        </button>
      </div>
      <p>{previewBaseline === null ? "Open the grey preview after all cards pass, rotate it, then close it." :
        `Thumbnail uploads since preview opened: ${previewWrites}. Expected: 0.`}</p>
      <div ref={grid} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 16 }}>
        {parts.map((part) => {
          const result = samples.find((entry) => entry.id === part.id);
          return <figure key={`${generation}:${part.id}`} data-part={part.id} style={{ padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
            <PartThumb partId={part.id} tintHex={part.hex} sizePx={128} eager fallbackLabel={part.label} />
            <figcaption style={{ fontSize: 13, marginTop: 8 }}>{part.label}</figcaption>
            <p style={{ fontSize: 11 }}>{result?.status ?? "waiting"}: {result?.detail ?? "Waiting for image"}</p>
          </figure>;
        })}
      </div>
      {previewOpen && <div role="dialog" aria-modal="true" aria-label="Grey preview" style={{ position: "fixed", inset: 0, zIndex: 100, background: "#000a", display: "grid", placeItems: "center" }}>
        <section style={{ width: "min(90vw, 700px)", padding: 20, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}>
          <button style={buttonStyle} onClick={() => setPreviewOpen(false)}>Close preview</button>
          <Preview3D partId={900_002} filename="fixture-grey.stl" meshColor="#747874" appearance="studio" className="thumbnail-regression-preview" />
        </section>
      </div>}
    </main>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Fixture root is missing");
const root = createRoot(container);
root.render(<Fixture />);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    window.fetch = originalFetch;
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
  });
}
