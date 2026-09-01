import { useEffect, useRef, useState } from "react";
import type { AcceptedPlateView } from "@print-partner/contracts";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { partMeshUrl } from "../../../api/endpoints/media";
import { acceptedPlateUnitColor } from "../../../lib/acceptedPlateColor";
import { addPreviewRig, createPreviewMaterial, createPreviewRig } from "../../../lib/previewRig";
import { rampColor, usePreviewTheme, type PreviewTheme } from "../../../lib/previewTheme";

const MAX_PREVIEW_PARTS = 40;

/** A unit's own filament colour, or the theme's categorical ramp entry. */
function unitColor(
  unit: { filament_hex?: string | null; filament_custom_hex?: string | null; filament_color_id?: string | null },
  index: number,
  theme: PreviewTheme,
): string {
  return acceptedPlateUnitColor(unit) ?? rampColor(theme, index);
}

export default function AcceptedPlate3DPreview({
  plate,
  onUnavailable,
}: {
  plate: AcceptedPlateView;
  onUnavailable?: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const theme = usePreviewTheme();
  const [message, setMessage] = useState("Loading Plate meshes…");

  // The theme is a dependency, not a live patch: a theme switch is rare and
  // the meshes come back from the browser cache, so rebuilding the scene is
  // cheaper than keeping every material, light and grid line in sync by hand.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(theme.background);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 5_000);
    camera.up.set(0, 0, 1);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setMessage("3D preview is unavailable in this browser. Use Edit layout instead.");
      onUnavailable?.();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const bedWidth = plate.printer.bed_width_um / 1_000;
    const bedDepth = plate.printer.bed_depth_um / 1_000;
    const bed = new THREE.Mesh(
      new THREE.PlaneGeometry(bedWidth, bedDepth),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(theme.bed),
        roughness: 0.72,
        metalness: 0.2,
      }),
    );
    bed.receiveShadow = true;
    scene.add(bed);
    const grid = new THREE.GridHelper(
      Math.max(bedWidth, bedDepth),
      20,
      new THREE.Color(theme.grid.major),
      new THREE.Color(theme.grid.minor),
    );
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.08;
    scene.add(grid);

    const maxBed = Math.max(bedWidth, bedDepth);
    const rig = createPreviewRig(theme, { up: "z", distance: maxBed });
    rig.key.castShadow = true;
    rig.key.shadow.camera.left = -maxBed;
    rig.key.shadow.camera.right = maxBed;
    rig.key.shadow.camera.top = maxBed;
    rig.key.shadow.camera.bottom = -maxBed;
    rig.key.shadow.camera.far = maxBed * 4;
    addPreviewRig(scene, rig);

    camera.position.set(maxBed * 0.7, -maxBed * 0.9, maxBed * 0.85);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.minDistance = maxBed * 0.35;
    controls.maxDistance = maxBed * 4;

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    let animationFrame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    };
    animate();

    const load = async () => {
      const previewUnits = plate.units.filter((unit) => unit.part_id != null).slice(0, MAX_PREVIEW_PARTS);
      if (previewUnits.length === 0) {
        setMessage("Mesh preview is unavailable for these legacy Plate parts.");
        return;
      }
      const buffers = new Map<number, ArrayBuffer>();
      let loaded = 0;
      await Promise.all(previewUnits.map(async (unit) => {
        if (unit.part_id == null) return;
        // Index within the Plate, not within the filtered preview list, so a
        // unit keeps the same ramp colour in the SVG bed and here.
        const index = plate.units.indexOf(unit);
        try {
          let buffer = buffers.get(unit.part_id);
          if (!buffer) {
            const response = await fetch(await partMeshUrl(unit.part_id), { credentials: "include" });
            if (!response.ok) return;
            buffer = await response.arrayBuffer();
            buffers.set(unit.part_id, buffer);
          }
          if (cancelled) return;
          const geometry = new STLLoader().parse(buffer.slice(0));
          geometry.computeBoundingBox();
          const bounds = geometry.boundingBox;
          if (!bounds) return;
          geometry.translate(-bounds.min.x, -bounds.min.y, -bounds.min.z);
          geometry.computeVertexNormals();
          const material = createPreviewMaterial(theme, unitColor(unit, index, theme));
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(
            unit.x_um / 1_000 - bedWidth / 2,
            unit.y_um / 1_000 - bedDepth / 2,
            0.1,
          );
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          scene.add(mesh);
          loaded += 1;
        } catch {
          // One missing or oversized mesh should not hide the rest of the Plate.
        }
      }));
      if (!cancelled) {
        const omitted = plate.units.length - previewUnits.length;
        setMessage(loaded === 0
          ? "Plate positions are saved, but its meshes could not be loaded."
          : `${loaded} mesh${loaded === 1 ? "" : "es"} loaded${omitted > 0 ? ` · ${omitted} omitted from the live preview` : ""}`);
      }
    };
    void load();

    return () => {
      cancelled = true;
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
      controls.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) material.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [onUnavailable, plate, theme]);

  return (
    <div className="space-y-2">
      <div
        ref={mountRef}
        className="h-[26rem] overflow-hidden rounded-xl border border-border bg-media shadow-lg"
        aria-label={`Rotatable 3D preview of Plate ${plate.ordinal}`}
      />
      <p className="text-xs text-muted-foreground">{message} · Drag to rotate, scroll to zoom.</p>
    </div>
  );
}
