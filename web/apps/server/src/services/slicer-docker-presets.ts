import type { SlicerInstanceKind } from "./slicer-instances.js";

/** Docker defaults aligned with pp-compose.yml stock services. */
export type SlicerDockerPreset = {
  kind: Exclude<SlicerInstanceKind, "custom">;
  image: string;
  container_name: string;
  compose_service: string;
  ports_json: string;
  volumes_json: string;
  env_json: string;
};

export function dockerPresetsForKind(kind: Exclude<SlicerInstanceKind, "custom">): SlicerDockerPreset {
  if (kind === "prusa") {
    return {
      kind,
      image: "mikeah/prusaslicer-novnc:latest",
      container_name: "prusaslicer",
      compose_service: "prusaslicer",
      ports_json: JSON.stringify([{ host: 3013, container: 8080, protocol: "tcp" }]),
      volumes_json: JSON.stringify([
        { host: "prusa-config", container: "/configs", mode: "rw" },
        { host: "pp-exchange", container: "/exchange", mode: "rw" },
      ]),
      env_json: "{}",
    };
  }
  if (kind === "bambu") {
    // No known BambuStudio noVNC image yet — seed a placeholder image string users can edit.
    return {
      kind,
      image: "",
      container_name: "bambustudio",
      compose_service: "bambustudio",
      ports_json: "[]",
      volumes_json: "[]",
      env_json: "{}",
    };
  }
  return {
    kind: "orca",
    image: "lscr.io/linuxserver/orcaslicer:latest",
    container_name: "orcaslicer",
    compose_service: "orcaslicer",
    ports_json: JSON.stringify([{ host: 3010, container: 3000, protocol: "tcp" }]),
    volumes_json: JSON.stringify([
      { host: "orca-config", container: "/config", mode: "rw" },
      { host: "pp-exchange", container: "/exchange", mode: "rw" },
    ]),
    env_json: JSON.stringify({ PUID: "1000", PGID: "1000" }),
  };
}
