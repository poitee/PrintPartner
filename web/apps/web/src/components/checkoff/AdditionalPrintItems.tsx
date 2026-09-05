import type { PrinterCheckoffLink } from "@print-partner/contracts";

export default function AdditionalPrintItems({ links }: { links: readonly PrinterCheckoffLink[] }) {
  const prints = links.filter((link) => link.imported_inventory?.extras.length);
  if (!prints.length) return null;
  return <section className="sheet-repo space-y-3" aria-label="Additional imported parts and files">
    <h3 className="sheet-repo-title font-semibold">Additional imported parts and files</h3>
    <p className="text-sm text-muted-foreground">Recorded separately from the Plan's required quantities.</p>
    {prints.map((link) => {
      const groups = new Map<string, { name: string; kind: string; result: string; count: number }>();
      for (const extra of link.imported_inventory?.extras ?? []) {
        const key = JSON.stringify([extra.name, extra.kind, extra.checkoff.result]);
        const group = groups.get(key) ?? { name: extra.name, kind: extra.kind, result: extra.checkoff.result, count: 0 };
        group.count++;
        groups.set(key, group);
      }
      return <div key={link.id} className="sheet-folder">
        <h4 className="sheet-folder-title break-words">{link.filename} · {link.host_name}</h4>
        <table className="sheet-table w-full text-left text-sm">
          <thead><tr><th>Part or file</th><th>Qty</th><th>Checkoff</th></tr></thead>
          <tbody>{[...groups].map(([key, group]) => <tr key={key}>
            <td className="break-words">{group.name}</td>
            <td>{group.kind === "file" ? "Unknown" : group.count}</td>
            <td>{group.result === "confirmed" ? "Checked" : group.result === "rejected" ? "Rejected" : "☐ Not checked"}</td>
          </tr>)}</tbody>
        </table>
      </div>;
    })}
  </section>;
}
