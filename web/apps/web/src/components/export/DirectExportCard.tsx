import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";

type Props = Readonly<{
  tokenCount: number;
  busy: boolean;
  onExport: () => void;
}>;

export default function DirectExportCard({ tokenCount, busy, onExport }: Props) {
  return (
    <Card className="flex flex-col border-border shadow-sm">
      <CardHeader className="space-y-2 pb-2">
        <CardTitle level={3} className="text-[13.5px] font-semibold leading-snug">
          Direct export
        </CardTitle>
        <CardDescription className="text-[12.5px] leading-relaxed">
          Skip Printer allocation and arrangement. Download one unarranged named-object 3MF
          for the selected units.
        </CardDescription>
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <Badge variant="muted" className="rounded-full px-2 py-0.5 font-mono text-[10.5px] font-normal">
            {tokenCount > 0 ? `${tokenCount} units` : "none selected"}
          </Badge>
          <Badge variant="muted" className="rounded-full px-2 py-0.5 font-mono text-[10.5px] font-normal">
            no arrangement
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="mt-auto pt-1">
        <Button size="sm" disabled={tokenCount === 0 || busy} loading={busy} onClick={onExport}>
          {busy ? "Exporting…" : "Direct 3MF"}
        </Button>
      </CardContent>
    </Card>
  );
}
