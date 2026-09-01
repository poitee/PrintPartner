import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { Button } from "@/components/ui/button";

type ConfirmDialogProps = {
  /**
   * The control that opens the dialog. Omit it and drive `open` yourself when
   * the question comes from somewhere other than a button press.
   */
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  /**
   * What the action will do, including anything it takes with it. Say the
   * whole consequence here — this is the last place to say it.
   */
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `destructive` is the default: a confirmation is for actions that destroy. */
  confirmVariant?: React.ComponentProps<typeof Button>["variant"];
  /**
   * Runs the action. The dialog closes itself afterwards; call
   * `event.preventDefault()` to keep it open, which is what you want when the
   * confirming button reports its own in-flight state.
   */
  onConfirm: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
};

/**
 * The one destructive confirmation in the app.
 *
 * Replaces `window.confirm`, which cannot be styled, cannot say what else the
 * action deletes, and blocks the browser. The confirming button is
 * `variant="destructive"` so the dangerous choice looks dangerous — the ghost
 * button this app used to use put the safe and the destructive choice at the
 * same visual weight.
 */
export default function ConfirmDialog({
  trigger,
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmVariant = "destructive",
  onConfirm,
  disabled,
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={confirmVariant}
            disabled={disabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
