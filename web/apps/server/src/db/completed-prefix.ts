export type CompletedUnit = {
  readonly unitIndex: number;
  readonly completed: boolean;
};

export function completedPrefixLength(units: readonly CompletedUnit[]): number {
  let count = 0;
  for (const unit of [...units].sort((left, right) => left.unitIndex - right.unitIndex)) {
    if (unit.unitIndex !== count || !unit.completed) break;
    count += 1;
  }
  return count;
}
