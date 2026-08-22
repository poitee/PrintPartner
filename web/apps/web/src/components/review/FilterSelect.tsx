import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { cn } from "../../lib/utils";

type Option = { value: string; label: string };

type Props = {
  value: string;
  onValueChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  "aria-label": string;
  className?: string;
  disabled?: boolean;
};

export default function FilterSelect({
  value,
  onValueChange,
  options,
  placeholder,
  "aria-label": ariaLabel,
  className,
  disabled,
}: Props) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        className={cn("h-9 max-w-[10rem] text-xs", className)}
        aria-label={ariaLabel}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value || "__empty"} value={opt.value || "__empty"}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Map empty sentinel back to real filter value. */
export function filterSelectValue(raw: string): string {
  return raw === "__empty" ? "" : raw;
}

export function filterSelectOut(value: string | null | undefined): string {
  return value ? value : "__empty";
}
