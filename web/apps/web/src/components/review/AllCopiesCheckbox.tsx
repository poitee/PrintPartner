import { useId } from "react";
import { Checkbox } from "../ui/checkbox";

export default function AllCopiesCheckbox({ filename, quantity, printedCount, disabled, onChange }: {
  filename: string;
  quantity: number;
  printedCount: number;
  disabled: boolean;
  onChange: (completed: boolean) => void;
}) {
  const id = useId();
  const checked = quantity > 0 && printedCount >= quantity
    ? true
    : printedCount > 0 ? "indeterminate" : false;
  return (
    <label htmlFor={id} className="no-print inline-flex min-h-10 items-center gap-2 text-sm">
      <Checkbox
        id={id}
        aria-label={`All copies printed for ${filename}`}
        checked={checked}
        disabled={disabled || quantity <= 0}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <span>{quantity === 1 ? "Printed" : `All ${quantity} copies`}</span>
    </label>
  );
}
