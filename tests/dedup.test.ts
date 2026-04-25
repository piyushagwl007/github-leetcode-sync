import { describe, expect, test, beforeEach } from "bun:test";
import { createDedupGate, contentMatches, type ChromeStorageLike } from "../src/lib/dedup";

// In-memory ChromeStorageLike for tests.
function makeStorage(initial: Record<string, unknown> = {}): ChromeStorageLike {
  const store = { ...initial };
  return {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    async set(items) {
      Object.assign(store, items);
    },
  };
}

describe("hasBeenProcessed", () => {
  test("returns false when storage is empty", async () => {
    const gate = createDedupGate({ storage: makeStorage() });
    expect(await gate.hasBeenProcessed("123")).toBe(false);
  });

  test("returns true once the id has been recorded", async () => {
    const gate = createDedupGate({ storage: makeStorage() });
    await gate.markProcessed("123");
    expect(await gate.hasBeenProcessed("123")).toBe(true);
  });

  test("ignores ids that look similar but are not equal", async () => {
    const gate = createDedupGate({ storage: makeStorage() });
    await gate.markProcessed("123");
    expect(await gate.hasBeenProcessed("1234")).toBe(false);
    expect(await gate.hasBeenProcessed("12")).toBe(false);
  });
});

describe("tryAcquireLock", () => {
  test("returns a lock for a fresh id", () => {
    const gate = createDedupGate({ storage: makeStorage() });
    const lock = gate.tryAcquireLock("123");
    expect(lock).not.toBeNull();
    expect(gate.isLocked("123")).toBe(true);
  });

  test("returns null when the same id is already locked", () => {
    const gate = createDedupGate({ storage: makeStorage() });
    const first = gate.tryAcquireLock("123");
    const second = gate.tryAcquireLock("123");
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("release frees the lock for re-acquisition", () => {
    const gate = createDedupGate({ storage: makeStorage() });
    const first = gate.tryAcquireLock("123")!;
    first.release();
    expect(gate.isLocked("123")).toBe(false);
    const second = gate.tryAcquireLock("123");
    expect(second).not.toBeNull();
  });

  test("locks for different ids do not interfere", () => {
    const gate = createDedupGate({ storage: makeStorage() });
    expect(gate.tryAcquireLock("a")).not.toBeNull();
    expect(gate.tryAcquireLock("b")).not.toBeNull();
    expect(gate.isLocked("a")).toBe(true);
    expect(gate.isLocked("b")).toBe(true);
  });

  test("multiple releases on the same lock are no-op", () => {
    const gate = createDedupGate({ storage: makeStorage() });
    const lock = gate.tryAcquireLock("a")!;
    lock.release();
    lock.release();
    expect(gate.isLocked("a")).toBe(false);
  });
});

describe("markProcessed", () => {
  test("persists the id so a fresh gate sees it", async () => {
    const storage = makeStorage();
    const gate = createDedupGate({ storage });
    await gate.markProcessed("123");

    const fresh = createDedupGate({ storage });
    expect(await fresh.hasBeenProcessed("123")).toBe(true);
  });

  test("is idempotent for the same id", async () => {
    const storage = makeStorage();
    const gate = createDedupGate({ storage });
    await gate.markProcessed("123");
    await gate.markProcessed("123");
    await gate.markProcessed("123");
    expect(await gate.getProcessedIds()).toEqual(["123"]);
  });

  test("caps the persisted list at 500 entries (FIFO eviction)", async () => {
    const storage = makeStorage();
    const gate = createDedupGate({ storage });

    for (let i = 1; i <= 510; i++) {
      await gate.markProcessed(String(i));
    }

    const ids = await gate.getProcessedIds();
    expect(ids).toHaveLength(500);
    expect(ids[0]).toBe("11");
    expect(ids.at(-1)).toBe("510");
    expect(await gate.hasBeenProcessed("1")).toBe(false);
    expect(await gate.hasBeenProcessed("11")).toBe(true);
    expect(await gate.hasBeenProcessed("510")).toBe(true);
  });

  test("tracks the highest submission id as last-synced", async () => {
    const gate = createDedupGate({ storage: makeStorage() });
    await gate.markProcessed("100");
    expect(await gate.getLastSyncedId()).toBe("100");
    await gate.markProcessed("250");
    expect(await gate.getLastSyncedId()).toBe("250");
    await gate.markProcessed("199");
    expect(await gate.getLastSyncedId()).toBe("250");
  });

  test("updates last-synced even when re-marking an existing id with a higher value", async () => {
    const storage = makeStorage({ lastSyncedSubmissionId: "100", processedSubmissionIds: ["999"] });
    const gate = createDedupGate({ storage });
    // 999 already processed; calling again with higher ID-as-string still bumps last
    await gate.markProcessed("999");
    expect(await gate.getLastSyncedId()).toBe("999");
  });
});

describe("getProcessedIds / getLastSyncedId", () => {
  test("returns empty list and null on a fresh gate", async () => {
    const gate = createDedupGate({ storage: makeStorage() });
    expect(await gate.getProcessedIds()).toEqual([]);
    expect(await gate.getLastSyncedId()).toBeNull();
  });

  test("tolerates non-array values in storage by treating as empty", async () => {
    const storage = makeStorage({ processedSubmissionIds: "not-an-array" });
    const gate = createDedupGate({ storage });
    expect(await gate.getProcessedIds()).toEqual([]);
  });

  test("tolerates non-string lastSyncedSubmissionId by treating as null", async () => {
    const storage = makeStorage({ lastSyncedSubmissionId: 123 });
    const gate = createDedupGate({ storage });
    expect(await gate.getLastSyncedId()).toBeNull();
  });
});

describe("contentMatches", () => {
  test("returns false when existing is null (file doesn't exist on GitHub)", () => {
    expect(contentMatches(null, "anything")).toBe(false);
  });

  test("returns true for byte-identical content", () => {
    expect(contentMatches("hello", "hello")).toBe(true);
  });

  test("ignores trailing whitespace differences (GitHub appends a newline)", () => {
    expect(contentMatches("hello\n", "hello")).toBe(true);
    expect(contentMatches("hello", "hello\n\n")).toBe(true);
  });

  test("normalizes CRLF vs LF", () => {
    expect(contentMatches("a\r\nb\r\nc", "a\nb\nc")).toBe(true);
  });

  test("treats meaningful body differences as not matching", () => {
    expect(contentMatches("def f(): return 1", "def f(): return 2")).toBe(false);
  });

  test("considers leading whitespace meaningful (it changes Python semantics)", () => {
    expect(contentMatches("    return x", "return x")).toBe(false);
  });
});

describe("integration: lock + markProcessed", () => {
  let gate: ReturnType<typeof createDedupGate>;
  beforeEach(() => {
    gate = createDedupGate({ storage: makeStorage() });
  });

  test("typical orchestration flow", async () => {
    // First call enters
    expect(await gate.hasBeenProcessed("777")).toBe(false);
    const lock = gate.tryAcquireLock("777");
    expect(lock).not.toBeNull();

    // A second concurrent fire bails out
    expect(gate.tryAcquireLock("777")).toBeNull();

    // First call finishes its work
    await gate.markProcessed("777");
    lock!.release();

    // A future fire sees the persisted state
    expect(await gate.hasBeenProcessed("777")).toBe(true);
    expect(gate.tryAcquireLock("777")).not.toBeNull(); // lock is reusable, hasBeenProcessed is the gate
  });
});
