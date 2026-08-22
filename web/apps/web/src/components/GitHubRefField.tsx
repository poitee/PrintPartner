import { useEffect, useRef, useState } from "react";
import { fetchGithubBranches, fetchGithubTags } from "../api/engine";

const GITHUB_REPO_RE =
  /^(?:https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?|git@github\.com:[\w.-]+\/[\w.-]+(?:\.git)?|[\w.-]+\/[\w.-]+(?:\.git)?)$/i;

export type GithubRefType = "branch" | "tag";

type Props = {
  url: string;
  refType: GithubRefType;
  branch: string;
  tag: string;
  onRefTypeChange: (refType: GithubRefType) => void;
  onBranchChange: (branch: string) => void;
  onTagChange: (tag: string) => void;
};

export default function GitHubRefField({
  url,
  refType,
  branch,
  tag,
  onRefTypeChange,
  onBranchChange,
  onTagChange,
}: Props) {
  const [options, setOptions] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  const value = refType === "tag" ? tag : branch;
  const onValueChange = refType === "tag" ? onTagChange : onBranchChange;

  useEffect(() => {
    const trimmed = url.trim();
    if (!GITHUB_REPO_RE.test(trimmed)) {
      setOptions(null);
      setLoading(false);
      setError(null);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    setOptions(null);
    setLoading(true);
    setError(null);

    debounceRef.current = setTimeout(() => {
      const requestId = ++requestIdRef.current;
      void (async () => {
        try {
          if (refType === "tag") {
            const result = await fetchGithubTags(trimmed);
            if (requestId !== requestIdRef.current) return;
            setOptions(result.tags);
            setManual(false);
            setError(null);
            if (result.tags.length > 0 && !result.tags.includes(tag)) {
              onTagChange(result.tags[0]);
            }
          } else {
            const result = await fetchGithubBranches(trimmed);
            if (requestId !== requestIdRef.current) return;
            setOptions(result.branches);
            setManual(false);
            setError(null);
            if (!branch.trim() || !result.branches.includes(branch)) {
              onBranchChange(result.default_branch);
            }
          }
        } catch (e) {
          if (requestId !== requestIdRef.current) return;
          setOptions(null);
          setManual(true);
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (requestId === requestIdRef.current) setLoading(false);
        }
      })();
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- branch/tag value changes should not re-fetch
  }, [url, refType]);

  const showDropdown = options != null && options.length > 0 && !manual;
  const label = refType === "tag" ? "Tag" : "Branch";

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <div className="inline-flex overflow-hidden rounded-md border border-border text-xs">
          <button
            type="button"
            className={`px-2 py-1 ${refType === "branch" ? "bg-primary text-primary-foreground" : "bg-background"}`}
            onClick={() => {
              setManual(false);
              onRefTypeChange("branch");
            }}
          >
            Branch
          </button>
          <button
            type="button"
            className={`px-2 py-1 ${refType === "tag" ? "bg-primary text-primary-foreground" : "bg-background"}`}
            onClick={() => {
              setManual(false);
              onRefTypeChange("tag");
            }}
          >
            Tag
          </button>
        </div>
      </div>
      {showDropdown ? (
        <select
          className="rounded-md border border-border bg-background px-3 py-2"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          disabled={loading}
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="rounded-md border border-border bg-background px-3 py-2"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={
            loading
              ? `Loading ${label.toLowerCase()}s…`
              : refType === "tag"
                ? "v1.0.0"
                : "main"
          }
          disabled={loading}
        />
      )}
      {loading && <span className="text-xs text-muted-foreground">Loading {label.toLowerCase()}s…</span>}
      {error && (
        <span className="text-xs text-muted-foreground">
          {error} Enter {label.toLowerCase()} manually.
        </span>
      )}
      {showDropdown && (
        <button
          type="button"
          className="self-start text-xs text-muted-foreground underline hover:text-foreground"
          onClick={() => setManual(true)}
        >
          Enter {label.toLowerCase()} manually
        </button>
      )}
    </div>
  );
}
