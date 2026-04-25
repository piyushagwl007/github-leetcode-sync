import { describe, expect, test, mock } from "bun:test";
import {
  extensionForLang,
  htmlToMarkdown,
  buildTestsJson,
  extractExampleOutputs,
  problemDirName,
  createLeetCodeClient,
  type ProblemMeta,
  type LeetCodeDeps,
} from "../src/lib/leetcode";

describe("extensionForLang", () => {
  test("maps known languages to their canonical extension", () => {
    expect(extensionForLang("python3")).toBe("py");
    expect(extensionForLang("Python")).toBe("py");
    expect(extensionForLang("cpp")).toBe("cpp");
    expect(extensionForLang("golang")).toBe("go");
    expect(extensionForLang("rust")).toBe("rs");
  });

  test("falls back to 'txt' for unknown or empty input", () => {
    expect(extensionForLang("brainfuck")).toBe("txt");
    expect(extensionForLang("")).toBe("txt");
    expect(extensionForLang(null)).toBe("txt");
    expect(extensionForLang(undefined)).toBe("txt");
  });
});

describe("htmlToMarkdown", () => {
  test("returns empty string for empty/null input", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown(null)).toBe("");
    expect(htmlToMarkdown(undefined)).toBe("");
  });

  test("converts inline emphasis tags", () => {
    expect(htmlToMarkdown("<strong>bold</strong> and <em>italic</em>")).toBe(
      "**bold** and *italic*"
    );
    expect(htmlToMarkdown("<b>bold</b> and <i>italic</i>")).toBe("**bold** and *italic*");
  });

  test("converts code spans and pre blocks", () => {
    expect(htmlToMarkdown("use <code>nums[i]</code>")).toBe("use `nums[i]`");
    expect(htmlToMarkdown("<pre>line1\nline2</pre>")).toContain("```");
  });

  test("decodes html entities", () => {
    expect(htmlToMarkdown("a &lt; b &amp;&amp; c &gt; d")).toBe("a < b && c > d");
    expect(htmlToMarkdown("&quot;hi&quot; &#39;there&#39;")).toBe(`"hi" 'there'`);
  });

  test("strips unknown tags entirely", () => {
    expect(htmlToMarkdown("<div><span>hello</span></div>")).toBe("hello");
  });

  test("collapses runs of blank lines", () => {
    const input = "<p>one</p><p>two</p>";
    const out = htmlToMarkdown(input);
    expect(out).not.toMatch(/\n{3,}/);
  });
});

describe("extractExampleOutputs", () => {
  test("extracts a single output from a typical example block", () => {
    const html = `<p><strong class="example">Example 1:</strong></p>
<pre><strong>Input:</strong> nums = [2,7,11,15], target = 9
<strong>Output:</strong> [0,1]
<strong>Explanation:</strong> Because nums[0] + nums[1] == 9, we return [0, 1].
</pre>`;
    expect(extractExampleOutputs(html)).toEqual(["[0,1]"]);
  });

  test("extracts multiple outputs in document order", () => {
    const html = `
<pre><strong>Input:</strong> nums = [2,7,11,15], target = 9
<strong>Output:</strong> [0,1]
</pre>
<pre><strong>Input:</strong> nums = [3,2,4], target = 6
<strong>Output:</strong> [1,2]
</pre>
<pre><strong>Input:</strong> nums = [3,3], target = 6
<strong>Output:</strong> [0,1]
</pre>`;
    expect(extractExampleOutputs(html)).toEqual(["[0,1]", "[1,2]", "[0,1]"]);
  });

  test("handles outputs without an Explanation that follows", () => {
    const html = `<pre><strong>Input:</strong> s = "abcabcbb"
<strong>Output:</strong> 3</pre>`;
    expect(extractExampleOutputs(html)).toEqual(["3"]);
  });

  test("decodes HTML entities in outputs", () => {
    const html = `<pre><strong>Output:</strong> &quot;hello&quot;</pre>`;
    expect(extractExampleOutputs(html)).toEqual([`"hello"`]);
  });

  test("strips inner tags (e.g. wrapped in <code>)", () => {
    const html = `<pre><strong>Output:</strong> <code>true</code></pre>`;
    expect(extractExampleOutputs(html)).toEqual(["true"]);
  });

  test("handles boolean and number outputs", () => {
    const html = `
<pre><strong>Output:</strong> true</pre>
<pre><strong>Output:</strong> false</pre>
<pre><strong>Output:</strong> 3.14159</pre>`;
    expect(extractExampleOutputs(html)).toEqual(["true", "false", "3.14159"]);
  });

  test("handles 'Output 1:' / 'Output 2:' numbered variants", () => {
    const html = `<pre><strong>Output 1:</strong> [1,2]
<strong>Output 2:</strong> [3,4]</pre>`;
    expect(extractExampleOutputs(html)).toEqual(["[1,2]", "[3,4]"]);
  });

  test("returns empty array for null/undefined/empty html", () => {
    expect(extractExampleOutputs(null)).toEqual([]);
    expect(extractExampleOutputs(undefined)).toEqual([]);
    expect(extractExampleOutputs("")).toEqual([]);
  });

  test("returns empty array when no Output: marker is present", () => {
    expect(extractExampleOutputs("<p>some prose with no examples</p>")).toEqual([]);
  });

  test("does not bleed into subsequent content (stops at next <strong>)", () => {
    const html = `<strong>Output:</strong> [1,2,3]<strong>Note:</strong> something irrelevant`;
    expect(extractExampleOutputs(html)).toEqual(["[1,2,3]"]);
  });
});

describe("buildTestsJson", () => {
  const baseQuestion: ProblemMeta = {
    questionFrontendId: "1",
    title: "Two Sum",
    titleSlug: "two-sum",
    difficulty: "Easy",
    content: "<p>Given an array...</p>",
    topicTags: [],
    sampleTestCase: "[2,7,11,15]\n9",
    exampleTestcaseList: ["[2,7,11,15]\n9", "[3,2,4]\n6"],
    metaData: JSON.stringify({
      name: "twoSum",
      params: [
        { name: "nums", type: "integer[]" },
        { name: "target", type: "integer" },
      ],
      return: { type: "integer[]" },
    }),
  };

  test("extracts function signature from metaData", () => {
    const result = buildTestsJson(baseQuestion);
    expect(result.functionName).toBe("twoSum");
    expect(result.returnType).toBe("integer[]");
    expect(result.params).toHaveLength(2);
    expect(result.params[0]).toEqual({ name: "nums", type: "integer[]" });
  });

  test("splits each example testcase on newlines", () => {
    const result = buildTestsJson(baseQuestion);
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0]?.input).toEqual(["[2,7,11,15]", "9"]);
    expect(result.cases[1]?.input).toEqual(["[3,2,4]", "6"]);
  });

  test("attaches expected outputs by index when provided", () => {
    const result = buildTestsJson(baseQuestion, ["[0,1]", "[1,2]"]);
    expect(result.cases[0]?.expected).toBe("[0,1]");
    expect(result.cases[1]?.expected).toBe("[1,2]");
  });

  test("leaves expected null when no outputs are provided", () => {
    const result = buildTestsJson(baseQuestion);
    expect(result.cases[0]?.expected).toBeNull();
  });

  test("falls back to sampleTestCase when exampleTestcaseList is empty", () => {
    const q: ProblemMeta = { ...baseQuestion, exampleTestcaseList: [] };
    const result = buildTestsJson(q);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]?.input).toEqual(["[2,7,11,15]", "9"]);
  });

  test("returns no cases when both fields are absent", () => {
    const q: ProblemMeta = { ...baseQuestion, exampleTestcaseList: null, sampleTestCase: null };
    const result = buildTestsJson(q);
    expect(result.cases).toHaveLength(0);
  });

  test("tolerates malformed metaData by treating it as empty", () => {
    const q: ProblemMeta = { ...baseQuestion, metaData: "{not json" };
    const result = buildTestsJson(q);
    expect(result.functionName).toBeNull();
    expect(result.params).toEqual([]);
    expect(result.returnType).toBeNull();
  });

  test("handles missing metaData", () => {
    const q: ProblemMeta = { ...baseQuestion, metaData: null };
    const result = buildTestsJson(q);
    expect(result.functionName).toBeNull();
  });
});

describe("problemDirName", () => {
  test("zero-pads ids to 4 digits", () => {
    expect(problemDirName("1", "two-sum")).toBe("0001-two-sum");
    expect(problemDirName("42", "trapping-rain-water")).toBe("0042-trapping-rain-water");
  });

  test("does not truncate ids longer than 4 digits", () => {
    expect(problemDirName("12345", "huge")).toBe("12345-huge");
  });
});

describe("createLeetCodeClient", () => {
  function makeDeps(overrides: Partial<LeetCodeDeps> = {}): LeetCodeDeps {
    return {
      fetchFn: mock(async () => new Response(JSON.stringify({ data: {} }))) as unknown as typeof fetch,
      getCookie: mock(async () => "csrf-token-value"),
      ...overrides,
    };
  }

  test("sends csrf token from cookie in x-csrftoken header", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ data: { userStatus: { username: "u", isSignedIn: true } } }))
    );
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    const client = createLeetCodeClient(deps);

    await client.fetchUsername();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-csrftoken"]).toBe("csrf-token-value");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("sends empty x-csrftoken when cookie is missing", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ data: { userStatus: null } }))
    );
    const deps = makeDeps({
      fetchFn: fetchFn as unknown as typeof fetch,
      getCookie: mock(async () => null),
    });
    const client = createLeetCodeClient(deps);

    await client.fetchUsername();

    const [, init] = fetchFn.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-csrftoken"]).toBe("");
  });

  test("fetchUsername returns null when not signed in", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ data: { userStatus: { username: "x", isSignedIn: false } } }))
    );
    const client = createLeetCodeClient(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    expect(await client.fetchUsername()).toBeNull();
  });

  test("fetchUsername returns username when signed in", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ data: { userStatus: { username: "alice", isSignedIn: true } } }))
    );
    const client = createLeetCodeClient(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    expect(await client.fetchUsername()).toBe("alice");
  });

  test("fetchRecentAcSubmissions returns the list", async () => {
    const submissions = [{ id: "1", title: "Two Sum", titleSlug: "two-sum", timestamp: "1", lang: "python3" }];
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ data: { recentAcSubmissionList: submissions } }))
    );
    const client = createLeetCodeClient(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    expect(await client.fetchRecentAcSubmissions("alice", 10)).toEqual(submissions);
  });

  test("fetchRecentAcSubmissions returns [] when API returns null", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ data: { recentAcSubmissionList: null } }))
    );
    const client = createLeetCodeClient(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    expect(await client.fetchRecentAcSubmissions("alice")).toEqual([]);
  });

  test("throws on non-2xx HTTP response", async () => {
    const fetchFn = mock(async () => new Response("oops", { status: 503 }));
    const client = createLeetCodeClient(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    await expect(client.fetchUsername()).rejects.toThrow(/503/);
  });

  test("throws when GraphQL response contains errors", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ errors: [{ message: "field bad" }, { message: "also bad" }] }))
    );
    const client = createLeetCodeClient(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    await expect(client.fetchUsername()).rejects.toThrow(/field bad; also bad/);
  });

  test("fetchSubmissionDetail coerces submissionId to a number for the variable", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ data: { submissionDetails: null } }))
    );
    const client = createLeetCodeClient(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    await client.fetchSubmissionDetail("12345");

    const [, init] = fetchFn.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.variables.submissionId).toBe(12345);
    expect(typeof body.variables.submissionId).toBe("number");
  });
});
