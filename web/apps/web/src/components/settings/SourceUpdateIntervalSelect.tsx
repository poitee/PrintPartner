import { SOURCE_UPDATE_INTERVAL_OPTIONS } from "../../lib/settingsPageModel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type SourceUpdateIntervalSelectProps = {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
};

export default function SourceUpdateIntervalSelect({
  value,
  disabled,
  onChange,
}: SourceUpdateIntervalSelectProps) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="min-h-10 w-full max-w-none sm:max-w-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SOURCE_UPDATE_INTERVAL_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
