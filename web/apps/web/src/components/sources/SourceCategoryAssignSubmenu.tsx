import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";
import { UNCategorized_FILTER } from "./sourceLabels";

type Props = {
  categories: string[];
  current: string | null | undefined;
  onAssign: (category: string | null) => void;
  disabled?: boolean;
};

/** Nested menu to assign a source to a single library category. */
export default function SourceCategoryAssignSubmenu({
  categories,
  current,
  onAssign,
  disabled,
}: Props) {
  const value = current?.trim() ? current.trim() : UNCategorized_FILTER;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>Category</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) =>
            onAssign(next === UNCategorized_FILTER ? null : next)
          }
        >
          <DropdownMenuRadioItem value={UNCategorized_FILTER}>
            Uncategorized
          </DropdownMenuRadioItem>
          {categories
            .filter((name) => name.trim() && name.trim() !== UNCategorized_FILTER)
            .map((name) => (
              <DropdownMenuRadioItem key={name} value={name}>
                {name}
              </DropdownMenuRadioItem>
            ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
