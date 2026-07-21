export class AsyncKeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(keys: Iterable<string>): Promise<() => void> {
    const releases: Array<() => void> = [];
    for (const key of [...new Set(keys)].sort()) {
      releases.push(await this.acquireOne(key));
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      for (const release of releases.reverse()) {
        release();
      }
    };
  }

  private async acquireOne(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let open!: () => void;
    const tail = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.tails.set(key, tail);
    await previous;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      open();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    };
  }
}
