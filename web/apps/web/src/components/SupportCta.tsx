import { Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SPONSOR_BUTTON_LABEL, openSponsor } from "@/lib/supportLinks";

type Props = {
  variant?: "default" | "secondary" | "ghost";
  size?: "default" | "sm";
  className?: string;
};

export default function SupportCta({
  variant = "secondary",
  size = "default",
  className,
}: Props) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      onClick={() => openSponsor()}
    >
      <Heart className="h-4 w-4" />
      {SPONSOR_BUTTON_LABEL}
    </Button>
  );
}
