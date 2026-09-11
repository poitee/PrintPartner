import { useEffect, useId, useState } from "react";
import { z } from "zod";
import {
  filenameGroupingSchema, filenameGroupKey, matchFilenameGroup, miloFilenameGrouping,
  type FilenameExport,
} from "@print-partner/contracts";
import { engineFetch } from "../../api/engineTransport";
import { Button } from "../ui/button";

const responseSchema = z.object({
  definition: filenameGroupingSchema,
  parts: z.array(z.object({ relativePath: z.string(), sourceLayer: z.string(), role: z.string(), units: z.array(z.object({ token: z.string(), completed: z.boolean() })) })),
});

export default function FilenameGroupingEditor({ profileId, onChange, selectedTokens = [], scope = "all" }: {
  profileId: number;
  onChange: (value: FilenameExport | undefined) => void;
  selectedTokens?: readonly string[];
  scope?: "all" | "remaining";
}) {
  const id = useId();
  const [data, setData] = useState<z.infer<typeof responseSchema> | null>(null);
  const [arrangement, setArrangement] = useState<FilenameExport["arrangement"]>("color_group");
  const [group, setGroup] = useState("");
  const [role, setRole] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void engineFetch<unknown>(`/plans/${profileId}/filename-grouping`).then((value) => {
      if (active) setData(responseSchema.parse(value));
    }).catch(() => { if (active) setMessage("Could not load filename groups. Close and reopen to retry."); });
    return () => { active = false; };
  }, [profileId]);

  const definition = data?.definition;
  const parsed = filenameGroupingSchema.safeParse(definition);
  const parts = data?.parts ?? [];
  const matches = definition ? parts.map((part) => ({ ...part, group: matchFilenameGroup(definition, part.relativePath, part.sourceLayer) })) : [];
  const tokenFilter = new Set(selectedTokens);
  const selected = matches.filter((part) =>
    (!role || part.role === role) && (!group || part.group === group.trim()) &&
    part.units.some((unit) => (scope === "all" || !unit.completed) && (tokenFilter.size === 0 || tokenFilter.has(unit.token))),
  );
  const conflict = selected.some((part) => part.group === "Conflict");
  const valid = parsed.success && !conflict;
  useEffect(() => {
    onChange(valid && definition ? { definition, arrangement, ...(group ? { group } : {}), ...(role ? { role } : {}) } : undefined);
  }, [definition, arrangement, group, role, valid, onChange]);

  if (!data) return <p role="status">{message || "Loading filename groups…"}</p>;
  const groups = [...new Set([...data.definition.rules.map((rule) => rule.group), ...Object.values(data.definition.overrides), "Unassigned"])];
  const edit = (next: typeof data.definition) => {
    setData({ ...data, definition: next });
    if (group && group !== "Unassigned" && !next.rules.some((rule) => rule.group === group) && !Object.values(next.overrides).includes(group)) setGroup("");
    setMessage("Unsaved changes. Download uses the rules shown here.");
  };
  return <section className="stack-row rounded-lg border p-3" aria-label="Custom filename grouping">
    <fieldset disabled={saving} className="stack-row">
    <p>Group filenames independently of Primary/Accent. Suffixes match before .stl, ignoring case. This does not apply slicer settings.</p>
    <label className="block">Grouping name <input className="border rounded p-2 bg-background" value={data.definition.name} onChange={(event) => edit({ ...data.definition, name: event.target.value })} /></label>
    {data.definition.rules.map((rule, index) => <div key={index} className="flex flex-wrap gap-2">
      <label>Filename suffix {index + 1} <input className="border rounded p-2 bg-background" value={rule.suffix} onChange={(event) => edit({ ...data.definition, rules: data.definition.rules.map((entry, i) => i === index ? { ...entry, suffix: event.target.value } : entry) })} /></label>
      <label>Group {index + 1} <input className="border rounded p-2 bg-background" value={rule.group} onChange={(event) => edit({ ...data.definition, rules: data.definition.rules.map((entry, i) => i === index ? { ...entry, group: event.target.value } : entry) })} /></label>
      <Button variant="outline" onClick={() => edit({ ...data.definition, rules: data.definition.rules.filter((_, i) => i !== index) })}>Remove rule {index + 1}</Button>
    </div>)}
    <div className="flex gap-2">
      <Button variant="outline" disabled={data.definition.rules.length >= 50} onClick={() => edit({ ...data.definition, rules: [...data.definition.rules, { suffix: "", group: "" }] })}>Add rule</Button>
      <Button variant="outline" onClick={() => edit({ ...miloFilenameGrouping, overrides: data.definition.overrides })}>Use Milo rules</Button>
      <Button disabled={!parsed.success || saving} onClick={async () => {
        setSaving(true);
        try {
          await engineFetch(`/plans/${profileId}/filename-grouping`, { method: "PUT", body: JSON.stringify(data.definition) });
          setMessage("Filename groups saved for this Build.");
        } catch { setMessage("Could not save filename groups. Your edits are still here."); }
        finally { setSaving(false); }
      }}>Save groups</Button>
    </div>
    {!parsed.success && <p role="alert">{parsed.error.issues[0]?.message}</p>}
    {message && <p role="status">{message}</p>}
    <label className="block" htmlFor={`${id}-order`}>Folder order</label><select id={`${id}-order`} className="border rounded p-2 bg-background" value={arrangement} onChange={(event) => {
      const next = event.target.value;
      if (next === "group" || next === "color_group" || next === "group_color") setArrangement(next);
    }}><option value="color_group">Color → {data.definition.name}</option><option value="group">{data.definition.name} only</option><option value="group_color">{data.definition.name} → Color</option></select>
    <label className="block" htmlFor={`${id}-role`}>Color role</label><select id={`${id}-role`} className="border rounded p-2 bg-background" value={role} onChange={(event) => setRole(event.target.value)}><option value="">All colors</option>{[...new Set(parts.map((part) => part.role))].map((value) => <option key={value}>{value}</option>)}</select>
    <label className="block" htmlFor={`${id}-group`}>Export group</label><select id={`${id}-group`} className="border rounded p-2 bg-background" value={group} onChange={(event) => setGroup(event.target.value)}><option value="">All groups</option>{groups.map((value) => <option key={value}>{value}</option>)}</select>
    <p>{selected.length} matching parts after color, group, Required-unit, and remaining-only filters.</p>
    {conflict && <p role="alert">Some filenames match different groups. Fix the rules or assign those parts below before downloading.</p>}
    <details><summary>Preview matches and assign exceptions</summary>
      <div className="max-h-80 overflow-auto"><table className="w-full text-sm"><thead><tr><th>File</th><th>Color role</th><th>Group</th><th>Override</th></tr></thead><tbody>
        {matches.map((part) => { const key = filenameGroupKey(part.sourceLayer, part.relativePath); return <tr key={key}>
          <td className="break-all">{part.sourceLayer}: {part.relativePath}</td><td>{part.role}</td><td>{part.group}</td><td><select aria-label={`Override ${part.sourceLayer}: ${part.relativePath}`} value={data.definition.overrides[key] ?? ""} onChange={(event) => {
            const overrides = { ...data.definition.overrides };
            if (event.target.value) overrides[key] = event.target.value; else delete overrides[key];
            edit({ ...data.definition, overrides });
          }}><option value="">Use filename rules</option>{groups.map((value) => <option key={value}>{value}</option>)}</select></td>
        </tr>; })}
      </tbody></table></div>
    </details>
    </fieldset>
  </section>;
}
