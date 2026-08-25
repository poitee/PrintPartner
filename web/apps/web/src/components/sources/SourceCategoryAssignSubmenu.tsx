import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";
import { UNCategorized_FILTER } from "./sourceLabels";
import { categoryMenuOptions } from "../../lib/sourceCategoryOptions";

type Props = {
  /** Flat, ordered category paths; subcategories render indented. */
  categories: string[];
  current: string | null | undefined;
  onAssign: (category: string | null) => void;
  disabled?: boolean;
};

/** Nested menu to file a source under a single library category or subcategory. */
export default function SourceCategoryAssignSubmenu({
  categories,
  current,
  onAssign,
  disabled,
}: Props) {
  const value = current?.trim() ? current.trim() : UNCategorized_FILTER;
  const options = categoryMenuOptions(categories);

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
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.path}
              value={option.path}
              style={option.indentStyle}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
