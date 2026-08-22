import {
  parseAcceptedPlateId,
  type AcceptedPlateId,
} from "@print-partner/contracts";

export type TransferTarget =
  | Readonly<{ kind: "plate"; plateId: AcceptedPlateId }>
  | Readonly<{ kind: "printer"; printerId: string }>;

const platePrefix = "plate:";
const printerPrefix = "printer:";

export function transferTargetValue(target: TransferTarget): string {
  return target.kind === "plate"
    ? `${platePrefix}${target.plateId}`
    : `${printerPrefix}${target.printerId}`;
}

export function parseTransferTarget(value: string): TransferTarget | null {
  if (value.startsWith(platePrefix)) {
    try {
      return { kind: "plate", plateId: parseAcceptedPlateId(value.slice(platePrefix.length)) };
    } catch {
      return null;
    }
  }
  if (!value.startsWith(printerPrefix)) return null;
  const printerId = value.slice(printerPrefix.length).trim();
  return printerId.length > 0 && printerId.length <= 200
    ? { kind: "printer", printerId }
    : null;
}
