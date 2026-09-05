import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  acceptedPartMediaMetadata,
  acceptedPartMediaRevalidationHeaders,
  partThumbnailUrl,
} from "../../api/endpoints/media";
import { generatePartThumbnail } from "../../lib/stlThumbnail";
import { fetchWithRetry } from "../../lib/fetchWithRetry";
import { acceptedThumbnailBlobCache } from "../../lib/acceptedThumbnailBlobCache";
import {
  getThumbnailCacheVersion,
  subscribeThumbnailCache,
} from "../../lib/thumbnailCache";

const DEFAULT_THUMB_PX = 96;
const MAX_RENDER_ATTEMPTS = 3;

type ThumbnailState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly url: string }
  | { readonly kind: "failed" };

export default memo(function PartThumb({
  partId,
  tintHex,
  compact,
  sizePx,
  eager = false,
  fallbackLabel,
}: {
  partId: number;
  tintHex?: string | null;
  compact?: boolean;
  sizePx?: number;
  eager?: boolean;
  fallbackLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const acceptedBasisRef = useRef<string | null>(null);
  const [thumbnail, setThumbnail] = useState<ThumbnailState>({ kind: "loading" });
  const [visible, setVisible] = useState(eager);
  const [intersecting, setIntersecting] = useState(eager);
  const cacheVersion = useSyncExternalStore(
    subscribeThumbnailCache,
    getThumbnailCacheVersion,
    getThumbnailCacheVersion,
  );

  useEffect(() => {
    if (eager) {
      setVisible(true);
      setIntersecting(true);
    }
  }, [eager]);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible || eager) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          setIntersecting(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, eager]);

  useEffect(() => {
    if (!visible || partId <= 0) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    let probe: HTMLImageElement | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let renderAttempts = 0;
    setThumbnail({ kind: "loading" });

    const priority = intersecting ? 1 : 0;

    const clearObjectUrl = () => {
      if (!objectUrl) return;
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    };

    const renderClientSide = () => {
      if (cancelled) return;
      renderAttempts += 1;
      const retry = () => {
        if (cancelled) return;
        if (renderAttempts < MAX_RENDER_ATTEMPTS) {
          retryTimer = setTimeout(renderClientSide, 500 * 2 ** (renderAttempts - 1));
        } else {
          setThumbnail({ kind: "failed" });
        }
      };
      void generatePartThumbnail(partId, { priority, cacheVersion }).then(
        (url) => {
          if (cancelled) {
            if (url) URL.revokeObjectURL(url);
            return;
          }
          if (url) {
            objectUrl = url;
            setThumbnail({ kind: "ready", url });
          } else {
            retry();
          }
        },
        retry,
      );
    };

    const loadServerThumbnail = async () => {
      try {
        const serverUrl = await partThumbnailUrl(partId);
        let response = await fetchWithRetry(serverUrl, {
          init: {
            headers: acceptedPartMediaRevalidationHeaders(acceptedBasisRef.current),
          },
          retryStatuses: [502, 503, 504],
        });
        if (!response.ok && response.status !== 304) return renderClientSide();
        if (response.headers.get("X-Thumbnail-Placeholder") === "1") {
          return renderClientSide();
        }
        let metadata = acceptedPartMediaMetadata(response);
        let blob =
          response.status === 304 ? acceptedThumbnailBlobCache.get(metadata.basis) : null;
        if (!blob) {
          if (response.status === 304) {
            response = await fetchWithRetry(serverUrl, { retryStatuses: [502, 503, 504] });
            if (!response.ok) return renderClientSide();
            metadata = acceptedPartMediaMetadata(response);
          }
          blob = await response.blob();
        }
        if (cancelled) return;
        acceptedBasisRef.current = metadata.basis;
        objectUrl = URL.createObjectURL(blob);
        probe = new Image();
        probe.onload = () => {
          if (cancelled) return;
          if (probe && probe.naturalWidth > 1 && probe.naturalHeight > 1) {
            acceptedThumbnailBlobCache.set(metadata.basis, blob);
            if (objectUrl) setThumbnail({ kind: "ready", url: objectUrl });
          } else {
            clearObjectUrl();
            renderClientSide();
          }
        };
        probe.onerror = () => {
          if (!cancelled) {
            clearObjectUrl();
            renderClientSide();
          }
        };
        probe.src = objectUrl;
      } catch {
        if (!cancelled) renderClientSide();
      }
    };

    void loadServerThumbnail();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      if (probe) {
        probe.onload = null;
        probe.onerror = null;
        probe = null;
      }
      clearObjectUrl();
    };
  }, [visible, intersecting, partId, tintHex, cacheVersion]);

  const px = sizePx ?? (compact ? 56 : DEFAULT_THUMB_PX);
  const label = fallbackLabel?.trim().slice(0, 3) || null;
  return (
    <div
      ref={ref}
      className="sheet-thumb"
      style={{ width: px, height: px }}
      title={thumbnail.kind === "failed" ? "Thumbnail unavailable. Open the 3D preview or refresh thumbnails to try again." : undefined}
    >
      {thumbnail.kind === "ready" ? (
        <img className="sheet-thumb-img" src={thumbnail.url} alt="" />
      ) : label ? (
        <span
          className="sheet-thumb-fallback"
          style={tintHex ? { color: tintHex } : undefined}
          aria-hidden
        >
          {label}
        </span>
      ) : (
        <div
          className="sheet-thumb-ph"
          style={{ background: tintHex ?? "var(--surface-sunken)" }}
          aria-hidden
        />
      )}
    </div>
  );
});
