import { describe, expect, test } from "bun:test";
import {
  validateConfig,
  formatStatus,
  summarizeOutcomes,
  defaultsFromUser,
} from "../src/lib/ui-helpers";

describe("validateConfig", () => {
  test("ok when all required fields are present", () => {
    const result = validateConfig({
      githubToken: "ghp_xxx",
      githubOwner: "alice",
      repoName: "leetcode",
    });
    expect(result.ok).toBe(true);
  });

  test("requires github token", () => {
    const r = validateConfig({ githubOwner: "alice", repoName: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("type narrow");
    expect(r.errors).toContain("GitHub token is required.");
  });

  test("treats whitespace-only token as missing", () => {
    const r = validateConfig({ githubToken: "   ", githubOwner: "a", repoName: "x" });
    expect(r.ok).toBe(false);
  });

  test("requires github owner (verify-token populates this)", () => {
    const r = validateConfig({ githubToken: "x", repoName: "y" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("");
    expect(r.errors.some(e => e.includes("username"))).toBe(true);
  });

  test("requires repo name", () => {
    const r = validateConfig({ githubToken: "x", githubOwner: "a" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("");
    expect(r.errors.some(e => e.includes("Repo name is required"))).toBe(true);
  });

  test("rejects repo names with disallowed characters", () => {
    const r = validateConfig({ githubToken: "x", githubOwner: "a", repoName: "bad name!" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("");
    expect(r.errors.some(e => e.includes("letters, numbers"))).toBe(true);
  });

  test("accepts repo names with allowed characters", () => {
    for (const name of ["leetcode", "leet-code", "leet_code", "leet.code", "LC123"]) {
      expect(validateConfig({ githubToken: "x", githubOwner: "a", repoName: name }).ok).toBe(true);
    }
  });

  test("accepts valid email addresses", () => {
    for (const email of ["a@b.co", "alice+tag@example.com", "1+alice@users.noreply.github.com"]) {
      const r = validateConfig({
        githubToken: "x",
        githubOwner: "a",
        repoName: "r",
        authorEmail: email,
      });
      expect(r.ok).toBe(true);
    }
  });

  test("rejects malformed email", () => {
    const r = validateConfig({
      githubToken: "x",
      githubOwner: "a",
      repoName: "r",
      authorEmail: "not-an-email",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("");
    expect(r.errors.some(e => e.includes("email"))).toBe(true);
  });

  test("rejects branch names with invalid characters", () => {
    const r = validateConfig({
      githubToken: "x",
      githubOwner: "a",
      repoName: "r",
      baseBranch: "with spaces",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("");
    expect(r.errors.some(e => e.includes("branch"))).toBe(true);
  });

  test("accepts common branch names", () => {
    for (const b of ["main", "master", "trunk", "release/1.0", "feature_x", "v1.0.0"]) {
      const r = validateConfig({
        githubToken: "x",
        githubOwner: "a",
        repoName: "r",
        baseBranch: b,
      });
      expect(r.ok).toBe(true);
    }
  });

  test("collects multiple errors at once", () => {
    const r = validateConfig({});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("");
    expect(r.errors.length).toBeGreaterThanOrEqual(3); // token + owner + repo
  });
});

describe("formatStatus", () => {
  test("guides the user to settings when not configured", () => {
    expect(
      formatStatus({ configured: false, owner: null, repo: null, lastSyncedId: null })
    ).toBe("Not configured — open Settings.");
  });

  test("shows target when configured but never synced", () => {
    expect(
      formatStatus({ configured: true, owner: "alice", repo: "leetcode", lastSyncedId: null })
    ).toBe("Configured: alice/leetcode. No syncs yet.");
  });

  test("shows last synced id when present", () => {
    expect(
      formatStatus({ configured: true, owner: "alice", repo: "leetcode", lastSyncedId: "12345" })
    ).toBe("Last synced submission #12345 → alice/leetcode");
  });

  test("falls back gracefully when configured flag is true but owner/repo missing", () => {
    expect(
      formatStatus({ configured: true, owner: null, repo: null, lastSyncedId: null })
    ).toContain("(no target)");
  });
});

describe("summarizeOutcomes", () => {
  test("empty list is friendly, not blank", () => {
    expect(summarizeOutcomes([])).toBe("No new submissions.");
  });

  test("counts synced", () => {
    expect(summarizeOutcomes([{ status: "synced" }, { status: "synced" }])).toBe("2 synced");
  });

  test("counts skipped and synced together", () => {
    expect(
      summarizeOutcomes([{ status: "synced" }, { status: "skipped" }, { status: "skipped" }])
    ).toBe("1 synced · 2 skipped");
  });

  test("counts errored", () => {
    expect(
      summarizeOutcomes([{ status: "synced" }, { status: "error" }])
    ).toBe("1 synced · 1 errored");
  });
});

describe("defaultsFromUser", () => {
  test("uses login when name and email are present", () => {
    expect(
      defaultsFromUser({ login: "alice", id: 100, name: "Alice Smith", email: "alice@example.com" })
    ).toEqual({
      githubOwner: "alice",
      authorName: "Alice Smith",
      authorEmail: "alice@example.com",
      noreplyEmail: "100+alice@users.noreply.github.com",
    });
  });

  test("falls back to login as name when name is missing", () => {
    const d = defaultsFromUser({ login: "alice", id: 100 });
    expect(d.authorName).toBe("alice");
  });

  test("falls back to noreply email when public email is null", () => {
    const d = defaultsFromUser({ login: "alice", id: 100, name: "Alice", email: null });
    expect(d.authorEmail).toBe("100+alice@users.noreply.github.com");
  });

  test("falls back to noreply email when public email is whitespace", () => {
    const d = defaultsFromUser({ login: "alice", id: 100, email: "   " });
    expect(d.authorEmail).toBe("100+alice@users.noreply.github.com");
  });

  test("noreply email always derives from id + login", () => {
    expect(defaultsFromUser({ login: "x", id: 42 }).noreplyEmail).toBe(
      "42+x@users.noreply.github.com"
    );
  });
});
