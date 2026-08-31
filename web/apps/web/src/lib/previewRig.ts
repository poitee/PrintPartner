/**
 * previewRig.ts
 * -------------
 * The three.js half of the preview theme: one construction of the shared
 * three-point rig and one construction of the shared mesh material.
 *
 * The Part thumbnail renderer, the expanded STL viewer, and the Plate preview
 * all build their lights here, so a Part cannot look one way at 96px and
 * another way in the dialog. Colour and intensity come from `PreviewTheme`;
 * this module only decides geometry (light directions) and lifecycle.
 *
 * Kept separate from previewTheme.ts so non-3D consumers — Part thumbnails'
 * placeholder, the phase swatch, the SVG Plate bed — can read the theme
 * without pulling three into their chunk.
 */

import * as THREE from "three";
import type { PreviewTheme } from "./previewTheme";

export type PreviewRig = Readonly<{
  ambient: THREE.AmbientLight;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
}>;

/** Key over the viewer's right shoulder, fill low and behind, in a Y-up scene. */
const KEY_DIRECTION = new THREE.Vector3(1, 1.2, 0.8);
const FILL_DIRECTION = new THREE.Vector3(-0.8, 0.4, -1);

function orient(direction: THREE.Vector3, up: "y" | "z", distance: number): THREE.Vector3 {
  const oriented =
    up === "z"
      ? new THREE.Vector3(direction.x, -direction.z, direction.y)
      : direction.clone();
  return oriented.multiplyScalar(distance);
}

/**
 * Build the shared rig. `up` matches the scene's up axis (the Plate bed is
 * Z-up); `distance` scales the light positions so shadow cameras frame scenes
 * measured in millimetres as well as ones normalised around the origin.
 */
export function createPreviewRig(
  theme: PreviewTheme,
  options: { readonly up?: "y" | "z"; readonly distance?: number } = {},
): PreviewRig {
  const up = options.up ?? "y";
  const distance = options.distance ?? 1;
  const { ambient, key, fill } = theme.rig;

  const ambientLight = new THREE.AmbientLight(new THREE.Color(ambient.color), ambient.intensity);
  const keyLight = new THREE.DirectionalLight(new THREE.Color(key.color), key.intensity);
  keyLight.position.copy(orient(KEY_DIRECTION, up, distance));
  const fillLight = new THREE.DirectionalLight(new THREE.Color(fill.color), fill.intensity);
  fillLight.position.copy(orient(FILL_DIRECTION, up, distance));

  return { ambient: ambientLight, key: keyLight, fill: fillLight };
}

/** Add the rig's lights to a scene. */
export function addPreviewRig(scene: THREE.Scene, rig: PreviewRig): void {
  scene.add(rig.ambient, rig.key, rig.fill);
}

/** Re-tint an existing rig after a theme switch, without rebuilding the scene. */
export function applyPreviewRig(rig: PreviewRig, theme: PreviewTheme): void {
  rig.ambient.color.set(theme.rig.ambient.color);
  rig.ambient.intensity = theme.rig.ambient.intensity;
  rig.key.color.set(theme.rig.key.color);
  rig.key.intensity = theme.rig.key.intensity;
  rig.fill.color.set(theme.rig.fill.color);
  rig.fill.intensity = theme.rig.fill.intensity;
}

/** The one material every previewed mesh uses, tinted with the filament hex. */
export function createPreviewMaterial(
  theme: PreviewTheme,
  color: string,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    metalness: theme.material.metalness,
    roughness: theme.material.roughness,
  });
}
