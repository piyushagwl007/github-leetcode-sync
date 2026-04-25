import { describe, expect, test } from "bun:test";
import {
  SUBMISSION_CHECK_PATH_REGEX,
  extractSubmissionId,
  isAcceptedSubmission,
  resolveFetchUrl,
  isAcceptedMessage,
  MESSAGE_SOURCE,
  MESSAGE_TYPE_ACCEPTED,
} from "../src/lib/submission-detection";

describe("SUBMISSION_CHECK_PATH_REGEX / extractSubmissionId", () => {
  test("matches the canonical check URL with id capture", () => {
    const url = "https://leetcode.com/submissions/detail/12345/check/";
    expect(SUBMISSION_CHECK_PATH_REGEX.test(url)).toBe(true);
    expect(extractSubmissionId(url)).toBe("12345");
  });

  test("matches without trailing slash", () => {
    expect(extractSubmissionId("https://leetcode.com/submissions/detail/9876/check")).toBe("9876");
  });

  test("matches a relative path (LeetCode SPA may use these)", () => {
    expect(extractSubmissionId("/submissions/detail/42/check/")).toBe("42");
  });

  test("matches large numeric ids (LeetCode IDs are ~1e9 today)", () => {
    expect(extractSubmissionId("/submissions/detail/1234567890/check/")).toBe("1234567890");
  });

  test("matches when /check is followed by a query string", () => {
    expect(
      extractSubmissionId("https://leetcode.com/submissions/detail/12345/check/?source=submit")
    ).toBe("12345");
    expect(extractSubmissionId("/submissions/detail/12345/check?foo=bar")).toBe("12345");
  });

  test("matches when /check is followed by a fragment", () => {
    expect(extractSubmissionId("/submissions/detail/12345/check#fragment")).toBe("12345");
  });

  test("does NOT match unrelated submission URLs", () => {
    expect(extractSubmissionId("https://leetcode.com/submissions/")).toBeNull();
    expect(extractSubmissionId("https://leetcode.com/submissions/detail/123/")).toBeNull();
    expect(extractSubmissionId("https://leetcode.com/api/submissions/check/")).toBeNull();
    expect(extractSubmissionId("https://leetcode.com/problems/two-sum/submit/")).toBeNull();
  });

  test("does NOT match URLs that merely contain '/check' as a substring of a different path", () => {
    expect(extractSubmissionId("/submissions/detail/123/checked")).toBeNull();
    expect(extractSubmissionId("/submissions/detail/123/check_something")).toBeNull();
  });

  test("does NOT match non-numeric ids", () => {
    expect(extractSubmissionId("/submissions/detail/abc/check/")).toBeNull();
    expect(extractSubmissionId("/submissions/detail/12abc/check/")).toBeNull();
  });

  test("does NOT match empty string", () => {
    expect(extractSubmissionId("")).toBeNull();
  });
});

describe("isAcceptedSubmission", () => {
  test("returns true for SUCCESS + Accepted", () => {
    expect(isAcceptedSubmission({ state: "SUCCESS", status_msg: "Accepted" })).toBe(true);
  });

  test("ignores extra fields when SUCCESS + Accepted", () => {
    expect(
      isAcceptedSubmission({
        state: "SUCCESS",
        status_msg: "Accepted",
        runtime: 50,
        memory: 17,
      })
    ).toBe(true);
  });

  test("returns false for in-progress polls", () => {
    expect(isAcceptedSubmission({ state: "PENDING" })).toBe(false);
    expect(isAcceptedSubmission({ state: "STARTED" })).toBe(false);
    expect(isAcceptedSubmission({ state: "STARTED", status_msg: "" })).toBe(false);
  });

  test("returns false for non-Accepted verdicts", () => {
    expect(isAcceptedSubmission({ state: "SUCCESS", status_msg: "Wrong Answer" })).toBe(false);
    expect(isAcceptedSubmission({ state: "SUCCESS", status_msg: "Time Limit Exceeded" })).toBe(false);
    expect(isAcceptedSubmission({ state: "SUCCESS", status_msg: "Runtime Error" })).toBe(false);
    expect(isAcceptedSubmission({ state: "SUCCESS", status_msg: "Compile Error" })).toBe(false);
  });

  test("returns false for non-objects", () => {
    expect(isAcceptedSubmission(null)).toBe(false);
    expect(isAcceptedSubmission(undefined)).toBe(false);
    expect(isAcceptedSubmission("Accepted")).toBe(false);
    expect(isAcceptedSubmission(42)).toBe(false);
    expect(isAcceptedSubmission([])).toBe(false);
  });

  test("returns false for case mismatch (avoids false positives)", () => {
    expect(isAcceptedSubmission({ state: "success", status_msg: "Accepted" })).toBe(false);
    expect(isAcceptedSubmission({ state: "SUCCESS", status_msg: "accepted" })).toBe(false);
  });
});

describe("resolveFetchUrl", () => {
  test("returns string input verbatim", () => {
    expect(resolveFetchUrl("https://example.com/path")).toBe("https://example.com/path");
  });

  test("stringifies a URL object", () => {
    expect(resolveFetchUrl(new URL("https://example.com/x"))).toBe("https://example.com/x");
  });

  test("extracts .url from a Request", () => {
    const req = new Request("https://example.com/api");
    expect(resolveFetchUrl(req)).toBe("https://example.com/api");
  });

  test("returns empty string for null/undefined", () => {
    expect(resolveFetchUrl(null)).toBe("");
    expect(resolveFetchUrl(undefined)).toBe("");
  });
});

describe("isAcceptedMessage", () => {
  test("accepts a well-formed envelope", () => {
    expect(
      isAcceptedMessage({
        source: MESSAGE_SOURCE,
        type: MESSAGE_TYPE_ACCEPTED,
        submissionId: "12345",
      })
    ).toBe(true);
  });

  test("rejects messages from other sources (avoids cross-extension or page-script confusion)", () => {
    expect(
      isAcceptedMessage({ source: "other-extension", type: MESSAGE_TYPE_ACCEPTED, submissionId: "1" })
    ).toBe(false);
    expect(
      isAcceptedMessage({ type: MESSAGE_TYPE_ACCEPTED, submissionId: "1" })
    ).toBe(false);
  });

  test("rejects unknown message types", () => {
    expect(
      isAcceptedMessage({ source: MESSAGE_SOURCE, type: "something_else", submissionId: "1" })
    ).toBe(false);
  });

  test("rejects when submissionId is missing or empty", () => {
    expect(
      isAcceptedMessage({ source: MESSAGE_SOURCE, type: MESSAGE_TYPE_ACCEPTED })
    ).toBe(false);
    expect(
      isAcceptedMessage({ source: MESSAGE_SOURCE, type: MESSAGE_TYPE_ACCEPTED, submissionId: "" })
    ).toBe(false);
  });

  test("rejects when submissionId is not a string (e.g. accidentally numeric)", () => {
    expect(
      isAcceptedMessage({ source: MESSAGE_SOURCE, type: MESSAGE_TYPE_ACCEPTED, submissionId: 12345 })
    ).toBe(false);
  });

  test("rejects non-objects", () => {
    expect(isAcceptedMessage(null)).toBe(false);
    expect(isAcceptedMessage(undefined)).toBe(false);
    expect(isAcceptedMessage("hello")).toBe(false);
    expect(isAcceptedMessage(42)).toBe(false);
  });
});
