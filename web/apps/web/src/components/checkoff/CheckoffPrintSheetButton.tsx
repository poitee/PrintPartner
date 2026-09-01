import { useId, useState } from "react";
import { Printer, Settings2 } from "lucide-react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
  const optionIdPrefix = useId();

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
            {OPTIONS.map((option) => {
              /* Named through `for`, because a <label> wrapper does not name a
                 button with role="checkbox". */
              const optionId = `${optionIdPrefix}-${option.key}`;
              return (
                <label
                  key={option.key}
                  htmlFor={optionId}
                  className="flex items-start gap-2 text-sm"
                >
                  <Checkbox
                    id={optionId}
                    className="mt-1"
                    checked={layout[option.key]}
                    onCheckedChange={(next) =>
                      onLayoutChange({ ...layout, [option.key]: next === true })
                    }
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              );
            })}
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
