import { useState } from "react";
import { Printer, Settings2 } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export type PrintSheetLayout = {
  compactMode: boolean;
  continuousPrintLayout: boolean;
  textOnlyPrint: boolean;
};

type Props = {
  layout: PrintSheetLayout;
  onLayoutChange: (layout: PrintSheetLayout) => void;
  onPrint: () => void;
  disabled?: boolean;
};

const OPTIONS: {
  key: keyof PrintSheetLayout;
  label: string;
  hint: string;
}[] = [
  { key: "compactMode", label: "Compact rows", hint: "Fits more parts on each page." },
  {
    key: "continuousPrintLayout",
    label: "Continuous",
    hint: "Fewer forced page breaks between sources.",
  },
  {
    key: "textOnlyPrint",
    label: "Text only, no thumbnails",
    hint: "Prints faster and saves ink.",
  },
];

/**
 * Print sheet as one action. The paper layout choices belong to that action,
 * not to the page header: an operator on a phone must see work first, and
 * nobody picks a paper layout while standing at a printer.
 */
export default function CheckoffPrintSheetButton({
  layout,
  onLayoutChange,
  onPrint,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="inline-flex items-stretch rounded-md">
      <Button
        type="button"
        variant="secondary"
        className="min-h-11 rounded-r-none"
        disabled={disabled}
        onClick={onPrint}
      >
        <Printer className="h-4 w-4" aria-hidden />
        Print sheet
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 rounded-l-none border-l-0 px-3"
            disabled={disabled}
            aria-label="Print sheet paper layout"
          >
            <Settings2 className="h-4 w-4" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold">Paper layout</legend>
            {OPTIONS.map((option) => (
              <label key={option.key} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4"
                  checked={layout[option.key]}
                  onChange={(event) =>
                    onLayoutChange({ ...layout, [option.key]: event.target.checked })
                  }
                />
                <span className="min-w-0">
                  <span className="block font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
            <Button
              type="button"
              className="min-h-11 w-full"
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                onPrint();
              }}
            >
              <Printer className="h-4 w-4" aria-hidden />
              Print sheet
            </Button>
          </fieldset>
        </PopoverContent>
      </Popover>
    </div>
  );
}
