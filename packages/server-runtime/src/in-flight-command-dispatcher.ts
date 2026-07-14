/**
 * Coalesces concurrent in-process attempts for the same command id.
 *
 * This is intentionally not a journal: outcomes disappear as soon as the
 * consumer settles and are not recovered after process restart.
 */
export class InFlightCommandDispatcher {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  dispatch<TResult>(
    commandId: string,
    consume: () => Promise<TResult>,
  ): Promise<TResult> {
    const existing = this.inFlight.get(commandId);
    if (existing) return existing as Promise<TResult>;
    const pending = consume().finally(() => {
      if (this.inFlight.get(commandId) === pending) {
        this.inFlight.delete(commandId);
      }
    });
    this.inFlight.set(commandId, pending);
    return pending;
  }

  isInFlight(commandId: string): boolean {
    return this.inFlight.has(commandId);
  }
}
