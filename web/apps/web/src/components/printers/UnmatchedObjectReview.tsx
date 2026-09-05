import { useId, useState } from "react";
import type { PrintFileMatchReview } from "@print-partner/contracts";
import { suggestSlicedObjectNames } from "@print-partner/domain/sliced-object-matching";
import type { ObjectMatchChoices } from "./objectMatchChoices";

type Props = {
  review: PrintFileMatchReview;
  choices: ObjectMatchChoices;
  onChange: (choices: ObjectMatchChoices) => void;
  disabled?: boolean;
  shortages: readonly string[];
};

export default function UnmatchedObjectReview(props: Props) {
  const groups = new Map<string, number[]>();
  for (const object of props.review.objects) {
    const indices = groups.get(object.name) ?? [];
    indices.push(object.object_index);
    groups.set(object.name, indices);
  }
  if (groups.size === 0 && !props.review.notices?.length) return null;
  return <fieldset disabled={props.disabled} className="stack-row rounded-md border border-border p-3">
    <legend className="text-body font-medium">Match remaining objects</legend>
    {groups.size > 0 ? <p className="text-meta text-muted-foreground">Suggestions are not selected automatically. Choose a plan part or leave the object unmatched. Nothing is marked printed here.</p> : null}
    {props.review.notices?.map((notice, index) => <p key={index} className="text-meta text-muted-foreground">{notice}</p>)}
    {[...groups].map(([name, indices]) => <ObjectGroup key={name} {...props} name={name} indices={indices} />)}
    {props.shortages.map((message) => <p key={message} role="alert" className="text-meta text-destructive">{message}</p>)}
  </fieldset>;
}

function ObjectGroup({ review, choices, onChange, name, indices }: Props & { name: string; indices: number[] }) {
  const id = useId();
  const [search, setSearch] = useState("");
  const firstIndex = indices[0];
  const partId = firstIndex === undefined ? undefined : choices.get(firstIndex);
  const count = indices.filter((index) => choices.has(index)).length;
  const suggestedPaths = suggestSlicedObjectNames(name, review.parts.map((part) => part.relative_path));
  const suggested = suggestedPaths.flatMap((path) => review.parts.filter((part) => part.relative_path === path));
  const needle = search.trim().toLowerCase();
  const searchParts = review.parts.filter((part) => `${part.filename} ${part.relative_path}`.toLowerCase().includes(needle));
  const visible = needle ? searchParts : suggested;
  const selected = review.parts.find((part) => part.part_id === partId);
  const options = selected && !visible.some((part) => part.part_id === selected.part_id) ? [selected, ...visible] : visible;
  const choose = (nextPartId: number | undefined, copies: number) => {
    const next = new Map(choices);
    for (const index of indices) next.delete(index);
    if (nextPartId !== undefined) for (const index of indices.slice(0, copies)) next.set(index, nextPartId);
    onChange(next);
  };
  return <div className="stack-row rounded-md bg-background p-3">
    <p className="break-words font-mono text-meta">{name} <span className="font-sans">× {indices.length}</span></p>
    <label htmlFor={`${id}-search`} className="text-meta">Search plan for {name}</label>
    <input id={`${id}-search`} type="search" value={search} onChange={(event) => setSearch(event.target.value)}
      placeholder="Find another part…" className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-body" />
    <label htmlFor={`${id}-part`} className="text-meta">Choose part for {name}</label>
    <select id={`${id}-part`} value={partId ?? ""} onChange={(event) => choose(event.target.value ? Number(event.target.value) : undefined, indices.length)}
      className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-body">
      <option value="">Leave unmatched</option>
      <optgroup label={needle ? "Plan search results" : "Suggested matches"}>
        {options.map((part) => <option key={part.part_id} value={part.part_id} disabled={part.units.length === 0}>
          {part.source_label ? `${part.source_label} / ` : ""}{part.relative_path} ({part.units.length} remaining)
        </option>)}
      </optgroup>
    </select>
    {options.length === 0 ? <p className="text-meta text-muted-foreground">No matching plan parts. Search by another name, or leave unmatched. Parts outside this plan must be added in Plan first.</p> : null}
    {partId !== undefined ? <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={`${id}-copies`} className="text-meta">Copies to match for {name}</label>
      <input id={`${id}-copies`} type="number" min={1} max={indices.length} value={count}
        onChange={(event) => { const n = Number(event.target.value); if (Number.isInteger(n) && n >= 1 && n <= indices.length) choose(partId, n); }}
        className="min-h-11 w-20 rounded-md border border-input bg-background px-2" />
      <span className="text-meta">{count} of {indices.length} copies selected</span>
    </div> : <p className="text-meta text-muted-foreground">{indices.length} {indices.length === 1 ? "copy" : "copies"} left unmatched</p>}
  </div>;
}
