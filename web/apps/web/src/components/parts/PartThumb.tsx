import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  acceptedPartMediaMetadata,
  acceptedPartMediaRevalidationHeaders,
  partThumbnailUrl,
} from "../../api/engine";
import { generatePartThumbnail } from "../../lib/stlThumbnail";
import { fetchWithRetry } from "../../lib/fetchWithRetry";
import { acceptedThumbnailBlobCache } from "../../lib/acceptedThumbnailBlobCache";
import {
  getThumbnailCacheVersion,
  subscribeThumbnailCache,
} from "../../lib/thumbnailCache";

const DEFAULT_THUMB_PX = 96;

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
  const [src, setSrc] = useState<string | null>(null);
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
    if (!visible) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    let probe: HTMLImageElement | null = null;

    const priority = intersecting ? 1 : 0;

    const clearObjectUrl = () => {
      if (!objectUrl) return;
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    };

    const renderClientSide = () => {
      void generatePartThumbnail(partId, { priority }).then((url) => {
        if (cancelled) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) {
          objectUrl = url;
          setSrc(url);
        }
      });
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
            setSrc(objectUrl);
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
    <div ref={ref} className="sheet-thumb" style={{ width: px, height: px }}>
      {src ? (
        <img className="sheet-thumb-img" src={src} alt="" />
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
          style={{ background: tintHex ?? "#e5e7eb" }}
          aria-hidden
        />
      )}
    </div>
  );
});
