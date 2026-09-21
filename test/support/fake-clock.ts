interface Timer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

export class FakeClock {
  private timestamp: number;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  public constructor(initial: string | Date = "2026-09-20T00:00:00.000Z") {
    this.timestamp = new Date(initial).getTime();
  }

  public now(): Date {
    return new Date(this.timestamp);
  }

  public setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.timestamp + delayMs, callback });
    return id;
  }

  public clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  public advanceBy(ms: number): void {
    const target = this.timestamp + ms;
    while (true) {
      const next = [...this.timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!next) break;
      this.timestamp = next.at;
      this.timers.delete(next.id);
      next.callback();
    }
    this.timestamp = target;
  }
}
