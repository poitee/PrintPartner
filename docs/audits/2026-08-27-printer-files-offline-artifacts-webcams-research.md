# Printer files, offline artifacts, and webcam research

Date: 2026-08-27

## Decision

PrintPartner should add one provider-neutral Production artifact workflow with three entry points:

1. Choose a file that already exists on a monitored printer.
2. Upload a sliced file for a printer that PrintPartner does not monitor.
3. Attach a 3MF project that still needs slicing.

The first two paths can produce a print-ready artifact. The third cannot be called print-ready unless PrintPartner can prove that the 3MF contains compatible toolpath data. All three paths must end at the same explicit task: link the artifact to Required units in a Production work package for one Accepted Plan revision.

Opening or inspecting a printer file must not start it. Linking it to a work package must not mark its Required units printed. Starting and completing a printer job remain separate actions.

Webcam support should use the same capability-based approach. Moonraker exposes camera configuration but supports several incompatible stream services. PrusaLink can expose snapshots for supported Raspberry Pi cameras. A Buddy3D Camera exposes a local RTSP stream, while Prusa Connect is the supported cloud viewer. PrintPartner should not promise one universal in-browser live-feed control.

## Why this belongs in the Production workflow

An existing printer file is not an exception to the PrintPartner model. It is another source for a sliced Production artifact. The artifact still needs to answer:

- Which Accepted Plan revision authorized it?
- Which Required units does it intend to produce?
- Which printer or unmonitored destination will use it?
- Has it been inspected, linked, started, completed, and verified?

The existing printer adapters can report status and upload files, but their shared interface does not expose stored-file discovery, download, metadata, or cameras. The existing unattributed-print flow begins after a completed printer event. The new workflow should make attribution possible before a print starts and use unattributed completion as a recovery path, not the normal path.

Keep these actions inside the durable Production work package proposed in the [cohesive workflow UX research](./2026-08-27-workflow-ux-research.md). Do not bind a remote file only to the Build or the Plan currently selected in the browser. Bind it to the immutable Accepted Plan revision and the relevant Production work package.

## Recommended operator experience

### Files already on a monitored printer

Add a `Files` view to each printer. Use the same file picker from the Production task `Add sliced file`.

The default view should show:

- File name and folder.
- Format.
- Modified time and size.
- Provider metadata such as estimated print time, filament use, layer height, and printer compatibility when available.
- Thumbnail when the provider offers one.
- Attribution state: `Unassigned`, `Linked to work package`, `Printing`, `Printed`, or `Stale`.

Selecting a file should open an inspection panel. The panel can suggest a Required-unit mapping, but the operator confirms it. Filename similarity alone is not enough evidence to create the link silently.

Use separate controls:

- `Inspect file` reads metadata and, when necessary, downloads a bounded copy for analysis.
- `Link to work package` records the Accepted Plan revision and selected Required units.
- `Start print` sends a distinct command after a final printer and unit summary.

If a linked remote path later reports a different provider revision, size, or modification time, mark the link stale. Do not silently treat the replacement bytes as the accepted artifact.

### Files for an unmonitored printer

In `Add sliced file`, offer `Upload for an unmonitored printer` alongside the monitored-printer picker. Accept G-code and binary G-code as potentially print-ready. Accept 3MF as a project or toolpath container that needs classification.

After upload:

1. Validate the container or file signature and calculate SHA-256.
2. Extract metadata on a best-effort basis.
3. Ask the operator to select the destination printer or enter an unmonitored destination label.
4. Ask the operator to map the artifact to Required units.
5. Show `Ready to transfer manually` only for a compatible print-ready artifact.
6. Offer download, QR transfer instructions, or a durable handoff receipt. Do not simulate printer monitoring.

The receipt should say that PrintPartner cannot observe job start or completion. The operator must record the result or complete Checkoff manually.

### Webcam controls

Add a `Camera` view to a printer only when its integration reports a usable camera capability. Show the source and limitations beside it, for example `Moonraker snapshot`, `Moonraker WebRTC`, `PrusaLink snapshot`, `Buddy3D local RTSP`, or `Open in Prusa Connect`.

Default cameras to off. Fetch an image only after the operator opens the view. Preserve a clear distinction between:

- Snapshot refresh.
- Browser-compatible live stream.
- Local RTSP that needs a relay or external player.
- External cloud viewer.

## Provider capability matrix

| Capability | Moonraker | PrusaLink | Prusa Connect / Buddy3D |
| --- | --- | --- | --- |
| List printer files | Supported through file-manager HTTP endpoints | Supported through storage and file endpoints | Connect UI supports cloud and printer files; no supported public third-party account browse API was found |
| Download a stored file | Supported through `/server/files/{root}/{filename}` | Use the returned `refs.download` URL | Connect UI can operate on files; no documented account-client download endpoint was found |
| File metadata | Rich but slicer-dependent G-code metadata | Optional `meta` with inconsistent literal key names | UI behavior is documented, not a public integration response schema |
| Thumbnail | Metadata and thumbnail endpoints | Returned `refs.thumbnail` and `refs.icon` | Available in Connect UI where supported |
| Camera discovery | Supported; Moonraker stores camera configuration | Supported on camera-capable PrusaLink installations | Buddy3D is managed through Connect and offers local RTSP |
| Snapshot | Provider URL from camera configuration | PNG snapshot endpoints | Connect shows periodic snapshots; no documented third-party retrieval API was found |
| Live feed | Depends on configured service: MJPEG, HLS, WebRTC, iframe, or other | No general live endpoint in the public OpenAPI | Buddy3D local RTSP; Prusa documentation describes cloud viewing separately |
| Authentication | API key, JWT, or trusted-client rules | HTTP Digest in the OpenAPI; current Prusa software also supports API-key deployments | Prusa account and Connect UI; local Buddy3D RTSP is documented as unencrypted |

## Moonraker file access

Moonraker's file-manager API is sufficient for listing, inspecting, and downloading files already stored under a configured root. The [official file-manager API](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/) documents these operations:

- `GET /server/files/list?root=gcodes` returns a flat array of file records with `path`, `modified`, `size`, and `permissions`.
- `GET /server/files/directory?path=gcodes/<directory>&extended=true` returns one directory at a time. Its result contains `dirs`, `files`, `disk_usage`, and `root_info`.
- `GET /server/files/metadata?filename=<path>` returns parsed metadata for a file relative to the `gcodes` root.
- `GET /server/files/thumbnails?filename=<path>` returns available thumbnail information.
- `GET /server/files/{root}/{filename}` returns the file bytes over HTTP.

The directory response uses this approximate provider shape:

```json
{
  "dirs": [
    { "dirname": "folder", "modified": 0, "size": 0, "permissions": "rw" }
  ],
  "files": [
    { "filename": "part.gcode", "modified": 0, "size": 0, "permissions": "rw" }
  ],
  "disk_usage": { "total": 0, "used": 0, "free": 0 },
  "root_info": { "name": "gcodes", "permissions": "rw" }
}
```

With `extended=true`, parsed metadata can be included on each file. The metadata endpoint may return slicer, time, temperature, layer, nozzle, filament, thumbnail, printer, and job fields. These fields are conditional. A provider can omit them when the file processor or slicer did not supply them. The response should therefore be normalized into optional PrintPartner fields, with the untouched provider metadata retained for inspection.

The flat list endpoint only reports files that Moonraker recognizes as valid G-code types. The directory endpoint is the better browser primitive because it supports folders and can expose other file types. File transfer operations are HTTP-only rather than JSON-RPC.

Moonraker does not expose a standard list of printable object names in its documented metadata response. For a stored inactive file, PrintPartner may need to download and parse the G-code, consult a prior PrintPartner export manifest, or ask for a manual Required-unit selection.

### Moonraker authentication

The [Moonraker authorization API](https://moonraker.readthedocs.io/en/latest/external_api/authorization/) accepts an API key in `X-Api-Key` or a user JWT in `Authorization: Bearer <token>`. Moonraker also documents a short-lived one-shot token for browser operations that cannot set headers. Trusted-client configuration may allow requests without a token.

PrintPartner should keep all long-lived credentials on the server. It should not place an API key or JWT in a camera or download URL sent to the browser. If it uses a one-shot token, it should mint or request it only for a specific browser operation and avoid recording the resulting URL.

Moonraker's configuration guidance warns that trusted clients receive broad API access. Its [authorization configuration](https://moonraker.readthedocs.io/en/latest/configuration/#authorization) recommends IP ranges instead of hostnames for trusted clients and says wildcard CORS should not be used in production.

## Moonraker webcam access

Moonraker does not operate the camera. It stores configuration for a camera service such as crowsnest. The [official webcam API](https://github.com/Arksine/moonraker/blob/master/docs/external_api/webcams.md) documents `GET /server/webcams/list`, with this response shape:

```json
{
  "webcams": [
    {
      "name": "cam",
      "location": "printer",
      "service": "mjpegstreamer",
      "enabled": true,
      "icon": "mdiWebcam",
      "target_fps": 15,
      "target_fps_idle": 5,
      "stream_url": "/webcam/?action=stream",
      "snapshot_url": "/webcam/?action=snapshot",
      "flip_horizontal": false,
      "flip_vertical": false,
      "rotation": 0,
      "aspect_ratio": "4:3",
      "extra_data": {},
      "source": "database",
      "uid": "provider-id"
    }
  ]
}
```

The `stream_url` and `snapshot_url` may be complete URLs or paths relative to the Moonraker host. `POST /server/webcams/test?uid=<uid>` resolves and tests the configured URLs and returns `name`, `snapshot_reachable`, `snapshot_url`, and `stream_url`.

Moonraker's [webcam configuration](https://github.com/Arksine/moonraker/blob/master/docs/configuration.md#webcam) recognizes several service types, including MJPEG variants, IP streams, HLS, WebRTC implementations, JMuxer, and iframe sources. These are not one browser media format. The adapter should report the service and resolved capabilities. The UI should render only formats PrintPartner explicitly supports.

A safe first release is server-proxied snapshots, with bounded refresh rates and image validation. MJPEG can follow if the proxy has connection and bandwidth limits. HLS and WebRTC need service-specific handling. An iframe source should not be embedded by default because its origin, framing policy, credentials, and content are outside PrintPartner's control.

## PrusaLink file access

The [official PrusaLink OpenAPI specification](https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml) documents storage discovery and nonrecursive file browsing:

- `GET /api/v1/storage` returns `storage_list`.
- `GET /api/v1/files/{storage}/{path}` returns information for a file or folder.
- A folder includes a `children` collection.
- A print file includes `refs.download`, `refs.icon`, and `refs.thumbnail`.

The storage response has this provider shape:

```json
{
  "storage_list": [
    {
      "name": "PrusaLink gcodes",
      "type": "LOCAL",
      "path": "/local",
      "print_files": 19216842,
      "system_files": 4242,
      "free_space": 1921681142,
      "total_space": 8589934592,
      "available": true,
      "read_only": false
    }
  ]
}
```

The documented storage types are `LOCAL`, `SDCARD`, and `USB`. File records share `name`, `read_only`, optional `size`, `type`, `m_timestamp`, and optional `display_name`. File `type` values include `PRINT_FILE`, `FIRMWARE`, `FILE`, and `FOLDER`.

Use the exact URL returned in `refs.download`, resolved against the configured printer origin. Do not construct a download URL from the storage name and path. The OpenAPI example uses a path like `/api/files/local/examples/<filename>.gcode/raw`.

Detailed print-file responses may include `meta`, but the schema is not a stable set of tidy application field names. It contains literal serialized keys such as `estimated printing time (normal mode)`, `filament used [mm]`, `filament used [mm] per tool`, `filament cost per tool`, and `nozzle_diameter per tool`, alongside keys such as `estimated_print_time`, `printer_model`, `layer_height`, and `profile`. Treat the provider object as untrusted optional metadata and normalize only known values.

### PrusaLink authentication and compatibility

The OpenAPI specification declares HTTP Digest authentication. Current [PrusaSlicer integration source](https://github.com/prusa3d/PrusaSlicer/blob/master/src/slic3r/Utils/OctoPrint.cpp) also supports `X-Api-Key` for PrusaLink key-based deployments and HTTP Digest for username and password deployments. PrintPartner should expose an explicit PrusaLink authentication mode or negotiate it during connection setup. Its current Digest-only adapter cannot cover every documented first-party client configuration.

Query `/api/version` first and keep the returned capabilities. Prusa firmware and standalone PrusaLink installations do not all expose identical storage, camera, or upload behavior. Use storage paths and file references returned by the device instead of assuming a `usb` path.

## Prusa Connect file access

Prusa describes Connect as the cloud service and PrusaLink as the local printer interface. The [official Connect and PrusaLink guide](https://help.prusa3d.com/article/prusa-connect-and-prusalink-explained_302608) documents Connect cloud storage and remote printer management. The current [official PDF guide](https://help.prusa3d.com/wp-content/uploads/generated/prusa-connect-prusalink_1636_guide_221744_en_2026-05-13.pdf) shows `Printer files` in the Connect interface, with cloud files and local PrusaLink G-codes.

No supported public third-party account API for listing and downloading a user's Connect files was found in Prusa's public documentation or first-party repositories. The public [Prusa Connect SDK Printer](https://github.com/prusa3d/Prusa-Connect-SDK-Printer) is a printer-to-Connect protocol. It is not an account-client API. The Connect API key in Prusa's [network G-code sending instructions](https://help.prusa3d.com/article/sending-g-codes-to-printer-via-network-prusa-connect-prusalink-octoprint_196761) is documented for sending files, not general cloud-file browsing.

Implement local PrusaLink browsing first. Do not scrape Connect's private web endpoints. Until Prusa publishes or grants a supported client API, offer an external `Open in Prusa Connect` action for cloud-only features.

## G-code, binary G-code, and 3MF

### ASCII G-code

Accept `.gcode` and the existing `.gco` alias as sliced artifacts. Parse metadata comments on a best-effort basis. The [PrusaSlicer G-code Viewer documentation](https://help.prusa3d.com/article/prusaslicer-g-code-viewer_193152) explains that PrusaSlicer adds comments such as `;TYPE:`, `;HEIGHT:`, `;LAYER_CHANGE`, `;COLOR_CHANGE`, and `;PAUSE_PRINT`. It also warns that G-code from other slicers may not contain metadata needed for all viewer features.

Do not make PrusaSlicer comments mandatory. Show unknown values as unknown. If the file has no trustworthy object mapping, require manual Required-unit selection. A file upload proves that bytes exist, not that any physical unit has been produced.

### Binary G-code

Accept `.bgcode` as a sliced artifact after structural validation. Prusa's [libbgcode project](https://github.com/prusa3d/libbgcode) documents a block-based container with file, slicer, printer, print, thumbnail, and G-code data. Blocks can use CRC32 checksums and can be compressed. G-code can use MeatPack encodings. Thumbnails can use PNG, JPEG, or QOI.

Do not inspect binary G-code by searching a fixed plaintext prefix. Metadata can be compressed or encoded. A correct parser must validate the header, block sizes, encodings, and checksums before trusting values.

The official library is AGPL-3.0. PrintPartner must complete a license review before linking, embedding, or copying code from it. The initial product can store the validated file, retain its hash, and require manual mapping while a compatible parsing strategy is selected.

### 3MF

Accept `.3mf`, but classify it before presenting next actions. The [3MF Core Specification](https://github.com/3MFConsortium/spec_core/blob/master/3MF%20Core%20Specification.md) defines a ZIP/OPC package with a required 3D model and optional metadata, thumbnails, signatures, print tickets, and custom parts. Its build section identifies model items intended for output. A generic 3MF is not necessarily sliced printer instructions.

Prusa's [3MF project documentation](https://help.prusa3d.com/article/saving-projects-as-3mf_1773) says a PrusaSlicer project stores objects, settings, modifiers, and parameters as a complete slicer snapshot. It still needs to be sliced into G-code or binary G-code for a printer.

Use these classifications:

- `Slicer project`: contains models and slicer settings; show `Needs slicing`.
- `Model package`: contains printable geometry without recognized slicer state; show `Needs preparation and slicing`.
- `Toolpath package`: contains recognized toolpath content; show `Compatibility review required` until printer compatibility is proven.
- `Unsupported 3MF`: valid container with content PrintPartner cannot safely interpret; allow download, not printing.

Extract object names, build items, core metadata, and thumbnails only within archive and XML safety limits. Never infer that every model resource is one Required unit. Instances, components, and build transforms can change physical quantity.

## Prusa cameras and Buddy3D

The PrusaLink OpenAPI defines camera discovery and PNG snapshot endpoints:

- `GET /api/v1/cameras`
- `GET /api/v1/cameras/{id}`
- `GET /api/v1/cameras/snap`
- `GET /api/v1/cameras/{id}/snap`

The last two return `image/png`. Availability depends on the PrusaLink installation. Prusa's [camera compatibility article](https://help.prusa3d.com/article/camera-compatibility-rpi-prusalink_654918) says the built-in PrusaLink on MK3.9, MK4, and XL does not support cameras and recommends assigning a camera through Connect.

The [official Buddy3D Camera documentation](https://help.prusa3d.com/article/buddy3d-camera_821264) describes periodic Connect snapshots and a local RTSP feed at `rtsp://<camera-ip>/live`, normally on port 554. It describes the local stream as unencrypted and LAN-only. The article directs users to the Prusa app or an RTSP-capable player such as VLC. A normal browser media element cannot play RTSP directly.

Prusa's public [Connect Camera API](https://help.prusa3d.com/article/prusa-connect-camera-api_569012) lets a camera producer register and upload snapshots. It does not document an account-client endpoint for PrintPartner to retrieve a user's Connect camera image or live feed.

For Buddy3D, the first release should offer:

- `Open in Prusa Connect` for supported cloud viewing.
- Optional local camera IP configuration for operators on the same LAN.
- `Open RTSP stream` where the operating environment has an external handler.
- A clear setup path for an optional server-side RTSP-to-WebRTC or RTSP-to-HLS relay if embedded live viewing is required.

Do not invent a Buddy3D snapshot URL. No official local snapshot endpoint was found. Do not expose port 554 to the public internet. If PrintPartner adds a relay, isolate it to configured camera addresses, authenticate viewers, limit concurrent sessions, and make the privacy impact explicit.

## Provider-neutral capability model

Keep provider response quirks behind deep adapter interfaces. Avoid adding Moonraker paths or Prusa `refs` handling to React pages.

```ts
type PrinterStoredFile = {
  id: string;
  printerId: string;
  integrationId: string;
  provider: "moonraker" | "prusalink";
  storage: string;
  path: string;
  displayName: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  providerRevision: string | null;
  format: "gcode" | "bgcode" | "3mf" | "unknown";
  metadata: NormalizedPrintMetadata;
  thumbnailCapability: CapabilityRef | null;
  downloadCapability: CapabilityRef | null;
};

type ProductionArtifactLink = {
  id: string;
  workPackageId: string;
  acceptedPlanRevisionId: string;
  source: "printer_file" | "upload" | "generated";
  printerStoredFileId: string | null;
  sha256: string | null;
  requiredUnitIds: string[];
  mappingMethod: "manifest" | "object_tags" | "filename_suggestion" | "manual";
  status: "unassigned" | "review_required" | "linked" | "stale" | "superseded";
};

type CameraFeed = {
  id: string;
  printerId: string;
  provider: "moonraker" | "prusalink" | "buddy3d" | "external";
  name: string;
  mode: "snapshot" | "mjpeg" | "hls" | "webrtc" | "rtsp" | "external";
  snapshotCapability: CapabilityRef | null;
  liveCapability: CapabilityRef | null;
  enabled: boolean;
  security: "server_proxy" | "same_lan" | "external_account";
};
```

These are design sketches, not prescribed database records. The important interface rules are:

- Listing returns metadata and opaque capabilities, not provider credentials or arbitrary URLs for the browser.
- Download and camera access go back through the adapter that issued the capability.
- Provider normalization is lossy by design, so raw metadata remains available for troubleshooting.
- Artifact attribution is separate from printer execution state and physical Checkoff.
- A durable file identity includes integration, printer, storage, path, size, modification time or provider revision, and a content hash after download.

## Security requirements

Printer files and camera configuration are untrusted network input even on a private LAN.

### File and URL safety

- Resolve Moonraker relative URLs against the configured Moonraker origin.
- Resolve PrusaLink `refs` against the configured PrusaLink origin.
- Reject cross-origin references unless the integration has an explicit separately validated media origin.
- Re-run outbound URL and DNS checks for every request and redirect. Never forward authorization headers across origins.
- Normalize remote path segments. Reject traversal segments, NUL bytes, ambiguous backslashes, and paths outside the selected provider root.
- Stream large files to bounded storage. Enforce response-size, time, and concurrency limits before parsing.
- Calculate SHA-256 for every downloaded or uploaded artifact retained by PrintPartner.
- Treat `Inspect` as read-only. Inspection must never upload, select, start, pause, or delete a printer job.

### Parser safety

- Validate file signatures instead of trusting extensions or response content types.
- Bound G-code line length, total parse work, and comment metadata size.
- Validate binary G-code block sizes, compression ratios, encodings, and checksums.
- For 3MF, cap archive entries, per-entry size, total decompressed size, nesting, and image dimensions. Reject path traversal and symbolic-link-like entries.
- Disable XML external entities, DTD processing, and outbound resource fetching.
- Decode thumbnails in an isolated, resource-limited path.

### Camera safety and privacy

- Keep printer and camera secrets server-side and redact them from logs and error messages.
- Treat all discovered camera URLs as SSRF candidates, including Moonraker values.
- Do not send a browser an authenticated private-LAN URL by default. Besides exposing location and credentials, an HTTPS PrintPartner page can encounter browser mixed-content restrictions when embedding insecure HTTP media. The [W3C Mixed Content specification](https://www.w3.org/TR/mixed-content/) defines those restrictions.
- Rate-limit snapshots and bound stream bandwidth, duration, and viewer count.
- Require operator permission to view a camera. Do not preload cameras on list pages.
- Label unencrypted Buddy3D RTSP and restrict it to the local network. The [RTSP 2.0 security guidance](https://www.rfc-editor.org/rfc/rfc7826.html#section-19) recommends TLS where confidentiality is required.

## Delivery order

### Phase 1: safe artifact attribution

- Add provider-neutral file-list, metadata, and bounded-download capabilities.
- Implement Moonraker directory browsing and PrusaLink storage browsing.
- Add an `Unassigned printer files` view and explicit Required-unit mapping.
- Bind linked artifacts to Production work packages and Accepted Plan revisions.
- Accept unmonitored `.gcode`, `.gco`, `.bgcode`, and `.3mf` uploads with classification, hashing, and safe manual mapping.
- Reuse unattributed completed-print recovery when a job finishes without a prior link.

### Phase 2: useful inspection

- Add thumbnails and normalized metadata.
- Add safe ASCII G-code object-tag parsing.
- Add 3MF project/build inspection.
- Select a legally and technically suitable binary G-code parsing strategy.
- Detect stale remote-file links and require reconfirmation.

### Phase 3: cameras

- Add Moonraker and PrusaLink snapshots behind a server proxy.
- Add explicit MJPEG, HLS, and WebRTC service handlers where tested.
- Add Buddy3D external Connect and local RTSP actions.
- Add an optional authenticated media relay only if embedded Buddy3D live video justifies its deployment and privacy cost.

## Acceptance criteria for the first release

- An operator can browse folders and inspect supported files on a Moonraker or PrusaLink printer without starting a print.
- An operator can link a stored file to selected Required units in one Production work package for one Accepted Plan revision.
- PrintPartner detects when the provider file at a linked path changes.
- An operator can upload G-code or binary G-code for an unmonitored printer and receive a durable manual-transfer record.
- An operator can upload 3MF, see whether it needs slicing, and cannot mistakenly mark an unsliced project print-ready.
- Missing provider metadata appears as unknown, not as zero or a guessed value.
- Printer credentials and raw authenticated file or camera URLs never reach the browser.
- Camera controls appear only for capabilities the integration can actually serve.
- A Buddy3D local stream is labeled LAN-only and unencrypted, and PrintPartner does not claim it can play RTSP without a relay or external handler.
