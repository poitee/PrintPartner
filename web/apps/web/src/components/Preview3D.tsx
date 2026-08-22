import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Loader2, Ruler } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import {
  CSS2DObject,
  CSS2DRenderer,
} from "three/examples/jsm/renderers/CSS2DRenderer.js";
import {
  acceptedPartMediaMetadata,
  partMeshUrl,
  partPreviewUrl,
  sourceStlMeshUrl,
  sourceStlPreviewUrl,
  uploadPartThumbnail,
} from "../api/engine";
import { fetchWithRetry } from "../lib/fetchWithRetry";

type Props = {
  partId: number | null;
  sourceId?: number | null;
  relativePath?: string | null;
  /** When set, preview the synced source STL instead of the plan part row. */
  preferSource?: boolean;
  filename?: string;
  meshColor?: string;
  className?: string;
  /** Keep full controls discoverable without persistent copy in compact surfaces. */
  instructions?: "visible" | "sr-only";
};

const DEFAULT_COLOR = "#c41230";
const MESH_MAX_BYTES = 15 * 1024 * 1024;

const DARK_BG = "#0a0e14";
const LIGHT_BG = "#dfe4ea";

/** Perceived luminance (0..1) of a hex color like "#1a2b3c". */
function perceivedLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Dark parts get a light backdrop; light parts keep the dark one. */
function contrastBackground(meshHex: string): string {
  return perceivedLuminance(meshHex) < 0.4 ? LIGHT_BG : DARK_BG;
}

/** STL units are millimeters by convention. */
function formatMm(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

/**
 * Dimension markers for the bounding box: a faint box outline plus X/Y/Z
 * measurement lines with end ticks and mm labels (CSS2D, so they stay
 * readable while the model rotates). Geometry is centered at the origin.
 */
function buildDimensionGroup(size: THREE.Vector3): THREE.Group {
  const group = new THREE.Group();
  const half = new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2);
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const off = maxDim * 0.08;
  const tick = maxDim * 0.03;

  const lineMat = new THREE.LineBasicMaterial({ color: 0xf97316 });
  const boxMat = new THREE.LineBasicMaterial({
    color: 0x94a3b8,
    transparent: true,
    opacity: 0.55,
  });

  group.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)),
      boxMat,
    ),
  );

  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  const addLine = (a: THREE.Vector3, b: THREE.Vector3) => {
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), lineMat));
  };

  const addLabel = (text: string, pos: THREE.Vector3) => {
    const el = document.createElement("div");
    el.className = "preview3d-dim-label";
    el.textContent = text;
    const label = new CSS2DObject(el);
    label.position.copy(pos);
    group.add(label);
  };

  // X — along the bottom-front edge.
  const xy = -half.y - off;
  const xz = half.z + off;
  addLine(v(-half.x, xy, xz), v(half.x, xy, xz));
  addLine(v(-half.x, xy, xz - tick), v(-half.x, xy, xz + tick));
  addLine(v(half.x, xy, xz - tick), v(half.x, xy, xz + tick));
  addLabel(`X ${formatMm(size.x)} mm`, v(0, xy, xz));

  // Y — along the front-right vertical edge.
  const yx = half.x + off;
  const yz = half.z + off;
  addLine(v(yx, -half.y, yz), v(yx, half.y, yz));
  addLine(v(yx - tick, -half.y, yz), v(yx + tick, -half.y, yz));
  addLine(v(yx - tick, half.y, yz), v(yx + tick, half.y, yz));
  addLabel(`Y ${formatMm(size.y)} mm`, v(yx, 0, yz));

  // Z — along the bottom-right edge.
  const zx = half.x + off;
  const zy = -half.y - off;
  addLine(v(zx, zy, -half.z), v(zx, zy, half.z));
  addLine(v(zx - tick, zy, -half.z), v(zx + tick, zy, -half.z));
  addLine(v(zx - tick, zy, half.z), v(zx + tick, zy, half.z));
  addLabel(`Z ${formatMm(size.z)} mm`, v(zx, zy, 0));

  return group;
}

function disposeDimensionGroup(group: THREE.Group) {
  group.traverse((obj) => {
    if (obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
  group.clear();
}

type PreviewTarget =
  | { kind: "part"; partId: number }
  | { kind: "source"; sourceId: number; relativePath: string };

function previewTarget(
  partId: number | null,
  sourceId: number | null | undefined,
  relativePath: string | null | undefined,
  preferSource = false,
): PreviewTarget | null {
  if (preferSource && sourceId != null && relativePath) {
    return { kind: "source", sourceId, relativePath };
  }
  if (partId != null) return { kind: "part", partId };
  if (sourceId != null && relativePath) {
    return { kind: "source", sourceId, relativePath };
  }
  return null;
}

function previewErrorMessage(status: number, kind: "mesh" | "png"): string {
  if (status === 404 && kind === "mesh") {
    return "STL not ready yet — source may still be syncing. Wait a moment and try again.";
  }
  if (status === 413) {
    return "STL is too large for live 3D preview — showing PNG instead.";
  }
  if (status === 404) {
    return "Preview image not available for this part.";
  }
  return `Preview unavailable (HTTP ${status}).`;
}

function previewUrlWithColor(url: string, meshColor: string): string {
  const hex = meshColor.trim();
  if (!hex) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}hex=${encodeURIComponent(hex)}`;
}

function normalizedRenderHex(value: string): string | null {
  const hex = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}

function optionalAcceptedPartMediaMetadata(response: Response) {
  try {
    return acceptedPartMediaMetadata(response);
  } catch {
    return null;
  }
}

export default function Preview3D({
  partId,
  sourceId = null,
  relativePath = null,
  preferSource = false,
  filename,
  meshColor = DEFAULT_COLOR,
  className = "",
  instructions = "visible",
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const dimsGroupRef = useRef<THREE.Group | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const showDimsRef = useRef(false);
  const instructionsId = useId();
  const [mode, setMode] = useState<"loading" | "mesh" | "png" | "empty" | "error">("empty");
  const [pngSrc, setPngSrc] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showDims, setShowDims] = useState(false);
  const [dims, setDims] = useState<{ x: number; y: number; z: number } | null>(null);

  const target = useMemo(
    () => previewTarget(partId, sourceId, relativePath, preferSource),
    [partId, sourceId, relativePath, preferSource],
  );
  const resolvedColor = meshColor || DEFAULT_COLOR;
  const targetKind = target?.kind ?? null;
  const targetPartId = target?.kind === "part" ? target.partId : null;
  const targetSourceId = target?.kind === "source" ? target.sourceId : null;
  const targetRelativePath = target?.kind === "source" ? target.relativePath : null;

  useEffect(() => {
    const material = materialRef.current;
    if (material) material.color.set(resolvedColor);
    const scene = sceneRef.current;
    if (scene) scene.background = new THREE.Color(contrastBackground(resolvedColor));
  }, [resolvedColor]);

  useEffect(() => {
    showDimsRef.current = showDims;
    if (dimsGroupRef.current) dimsGroupRef.current.visible = showDims;
  }, [showDims]);

  useEffect(() => {
    if (target == null) {
      setMode("empty");
      setPngSrc(null);
      setErrorMessage(null);
      setDims(null);
      materialRef.current = null;
      sceneRef.current = null;
      dimsGroupRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      return;
    }

    let cancelled = false;
    let frameId = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let labelRenderer: CSS2DRenderer | null = null;
    let controls: OrbitControls | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let geometry: THREE.BufferGeometry | null = null;

    const cleanupThree = () => {
      if (frameId) cancelAnimationFrame(frameId);
      controls?.dispose();
      controlsRef.current = null;
      cameraRef.current = null;
      geometry?.dispose();
      geometry = null;
      materialRef.current?.dispose();
      materialRef.current = null;
      if (dimsGroupRef.current) {
        disposeDimensionGroup(dimsGroupRef.current);
        dimsGroupRef.current = null;
      }
      sceneRef.current = null;
      if (labelRenderer) {
        labelRenderer.domElement.remove();
        labelRenderer = null;
      }
      if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
        renderer = null;
      }
    };

    const meshUrlFor = async () => {
      if (target.kind === "part") return partMeshUrl(target.partId);
      return sourceStlMeshUrl(target.sourceId, target.relativePath);
    };

    const previewUrlFor = async () => {
      if (target.kind === "part") return partPreviewUrl(target.partId);
      return sourceStlPreviewUrl(target.sourceId, target.relativePath);
    };

    const showPngFallback = async (meshStatus?: number) => {
      try {
        const url = previewUrlWithColor(await previewUrlFor(), resolvedColor);
        const response = await fetchWithRetry(url);
        if (cancelled) return;
        if (!response.ok) {
          setMode("error");
          setErrorMessage(
            meshStatus === 404 && response.status === 404
              ? previewErrorMessage(404, "mesh")
              : previewErrorMessage(response.status, "png"),
          );
          setPngSrc(null);
          return;
        }
        setPngSrc(url);
        setMode("png");
      } catch {
        if (!cancelled) {
          setMode("error");
          setErrorMessage("Could not load preview — check that the engine is running.");
          setPngSrc(null);
        }
      }
    };

    const initMesh = async () => {
      setMode("loading");
      setPngSrc(null);
      setErrorMessage(null);
      setDims(null);
      cleanupThree();

      try {
        const response = await fetchWithRetry(meshUrlFor);
        if (cancelled) return;

        if (response.status === 413 || !response.ok) {
          await showPngFallback(response.status);
          return;
        }
        const acceptedMedia =
          target.kind === "part" ? optionalAcceptedPartMediaMetadata(response) : null;

        const buffer = await response.arrayBuffer();
        if (cancelled) return;
        if (buffer.byteLength > MESH_MAX_BYTES) {
          await showPngFallback(413);
          return;
        }

        const mount = mountRef.current;
        if (!mount) return;

        const loader = new STLLoader();
        geometry = loader.parse(buffer);
        geometry.computeBoundingBox();
        geometry.center();
        geometry.computeVertexNormals();

        const bbox = geometry.boundingBox;
        const size = new THREE.Vector3();
        bbox?.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z, 1);

        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(resolvedColor),
          metalness: 0.15,
          roughness: 0.65,
        });
        materialRef.current = material;
        const mesh = new THREE.Mesh(geometry, material);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(contrastBackground(resolvedColor));
        sceneRef.current = scene;
        scene.add(mesh);

        const dimsGroup = buildDimensionGroup(size);
        dimsGroup.visible = showDimsRef.current;
        scene.add(dimsGroup);
        dimsGroupRef.current = dimsGroup;
        setDims({ x: size.x, y: size.y, z: size.z });

        scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        const key = new THREE.DirectionalLight(0xffffff, 0.85);
        key.position.set(1, 1.2, 0.8);
        const fill = new THREE.DirectionalLight(0xffffff, 0.35);
        fill.position.set(-0.8, 0.4, -1);
        scene.add(key, fill);

        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, maxDim * 20);
        camera.position.set(maxDim * 1.4, maxDim * 1.1, maxDim * 1.6);
        cameraRef.current = camera;

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        mount.appendChild(renderer.domElement);

        labelRenderer = new CSS2DRenderer();
        labelRenderer.domElement.style.position = "absolute";
        labelRenderer.domElement.style.top = "0";
        labelRenderer.domElement.style.left = "0";
        labelRenderer.domElement.style.pointerEvents = "none";
        mount.appendChild(labelRenderer.domElement);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.minDistance = maxDim * 0.25;
        controls.maxDistance = maxDim * 8;
        controlsRef.current = controls;

        const resize = () => {
          if (!mount || !renderer) return;
          const width = mount.clientWidth || 320;
          const height = Math.max(220, Math.min(360, width * 0.75));
          renderer.setSize(width, height, false);
          labelRenderer?.setSize(width, height);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };

        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(mount);
        resize();

        const animate = () => {
          if (cancelled) return;
          controls?.update();
          renderer?.render(scene, camera);
          labelRenderer?.render(scene, camera);
          frameId = requestAnimationFrame(animate);
        };
        animate();

        setMode("mesh");
        if (
          target.kind === "part" &&
          acceptedMedia?.renderHex != null &&
          normalizedRenderHex(resolvedColor) === acceptedMedia.renderHex
        ) {
          const partIdForThumb = target.partId;
          const meshBasis = acceptedMedia.basis;
          setTimeout(() => {
            if (cancelled || !renderer) return;
            renderer.domElement.toBlob((blob) => {
              if (blob) {
                void uploadPartThumbnail(partIdForThumb, blob, meshBasis).catch(() => {});
              }
            }, "image/png");
          }, 900);
        }
      } catch {
        if (!cancelled) await showPngFallback();
      }
    };

    void initMesh();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      cleanupThree();
    };
  }, [target, targetKind, targetPartId, targetSourceId, targetRelativePath, resolvedColor]);

  useEffect(() => {
    if (target == null || mode !== "png") return;
    let cancelled = false;

    const reloadPng = async () => {
      try {
        const base =
          target.kind === "part"
            ? await partPreviewUrl(target.partId)
            : await sourceStlPreviewUrl(target.sourceId, target.relativePath);
        const url = previewUrlWithColor(base, resolvedColor);
        const response = await fetchWithRetry(url);
        if (cancelled) return;
        if (!response.ok) return;
        setPngSrc(url);
      } catch {
        return;
      }
    };

    void reloadPng();
    return () => {
      cancelled = true;
    };
  }, [resolvedColor, mode, target, targetKind, targetPartId, targetSourceId, targetRelativePath]);

  const onPreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    const rotationStep = Math.PI / 18;
    let handled = true;

    switch (event.key) {
      case "ArrowLeft":
        spherical.theta -= rotationStep;
        break;
      case "ArrowRight":
        spherical.theta += rotationStep;
        break;
      case "ArrowUp":
        spherical.phi -= rotationStep;
        break;
      case "ArrowDown":
        spherical.phi += rotationStep;
        break;
      case "+":
      case "=":
        spherical.radius *= 0.9;
        break;
      case "-":
      case "_":
        spherical.radius *= 1.1;
        break;
      default:
        handled = false;
    }

    if (!handled) return;
    event.preventDefault();
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, 0.05, Math.PI - 0.05);
    spherical.radius = THREE.MathUtils.clamp(
      spherical.radius,
      controls.minDistance,
      controls.maxDistance,
    );
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    camera.lookAt(controls.target);
    controls.update();
  };

  if (target == null) {
    return (
      <div className={`preview3d ${className}`.trim()}>
        <p className="muted">Select a file to preview its STL.</p>
      </div>
    );
  }

  return (
    <div className={`preview3d ${className}`.trim()}>
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {mode === "loading" ? "Loading 3D preview…" : ""}
      </p>
      {filename && <p className="preview-filename">{filename}</p>}
      {mode === "loading" && (
        <p className="muted flex items-center gap-2" aria-hidden="true">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
          Loading 3D preview…
        </p>
      )}
      {mode === "png" && pngSrc && (
        <>
          <p className="muted small">Large mesh — showing PNG preview.</p>
          <img
            className="preview-image"
            src={pngSrc}
            alt={filename ? `Preview of ${filename}` : "Part preview"}
            onError={() => {
              setMode("error");
              setErrorMessage("Preview image failed to load.");
              setPngSrc(null);
            }}
          />
        </>
      )}
      {mode === "error" && (
        <p className="preview-error text-sm text-destructive" role="alert">
          {errorMessage}
        </p>
      )}
      <div className="preview3d-stage" hidden={mode !== "mesh"}>
        <div
          ref={mountRef}
          className="preview3d-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="application"
          tabIndex={0}
          aria-label={
            filename
              ? `Interactive 3D preview of ${filename}`
              : "Interactive 3D STL preview"
          }
          aria-describedby={instructionsId}
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + -"
          onKeyDown={onPreviewKeyDown}
        />
        <button
          type="button"
          className="preview3d-measure-btn"
          onClick={() => setShowDims((s) => !s)}
          aria-pressed={showDims}
          title={showDims ? "Hide measurements" : "Show measurements"}
        >
          <Ruler className="h-3.5 w-3.5" aria-hidden />
          {showDims ? "Hide measurements" : "Measure"}
        </button>
        {showDims && dims && (
          <p className="muted small preview3d-dims-caption">
            {formatMm(dims.x)} × {formatMm(dims.y)} × {formatMm(dims.z)} mm (X × Y × Z)
          </p>
        )}
        <p
          id={instructionsId}
          className={instructions === "sr-only" ? "sr-only" : "muted small mt-2"}
        >
          Drag or swipe to orbit. Scroll or pinch to zoom. With the preview
          focused, use arrow keys to orbit and + or − to zoom. Measure shows
          exact dimensions.
        </p>
      </div>
    </div>
  );
}
