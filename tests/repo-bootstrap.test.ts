import { describe, expect, test } from "bun:test";
import { generateBootstrapFiles, generateProblemFiles, wrapForLanguage } from "../src/lib/repo-bootstrap";

describe("generateBootstrapFiles", () => {
  const files = generateBootstrapFiles({ projectName: "leetcode", description: "my solutions" });
  const byPath = Object.fromEntries(files.map(f => [f.path, f.content]));

  test("produces all the expected files", () => {
    expect(files.map(f => f.path).sort()).toEqual(
      [
        ".github/workflows/test.yml",
        ".gitignore",
        "README.md",
        "pyproject.toml",
        "solutions/__init__.py",
        "solutions/conftest.py",
        "solutions/test_solutions.py",
        "solutions/helpers.py",
      ].sort()
    );
  });

  test("README references uv and the solutions/ layout", () => {
    expect(byPath["README.md"]).toContain("uv run pytest");
    expect(byPath["README.md"]).toContain("solutions/");
    expect(byPath["README.md"]).toContain("conftest.py");
  });

  test("README uses the provided project name and description", () => {
    expect(byPath["README.md"]).toContain("# leetcode");
    expect(byPath["README.md"]).toContain("my solutions");
  });

  test("README falls back to a default description when omitted", () => {
    const out = generateBootstrapFiles({ projectName: "x" });
    const readme = out.find(f => f.path === "README.md")!.content;
    expect(readme).toContain("Auto-synced");
  });

  test("pyproject.toml declares pytest in the dev dependency group and pins python", () => {
    const py = byPath["pyproject.toml"]!;
    expect(py).toContain('name = "leetcode"');
    expect(py).toContain('requires-python = ">=3.11"');
    expect(py).toMatch(/\[dependency-groups\][\s\S]*pytest/);
    expect(py).toContain('testpaths = ["solutions"]');
  });

  test("pyproject.toml description is JSON-quoted (handles quotes safely)", () => {
    const out = generateBootstrapFiles({ projectName: "x", description: 'has "quotes"' });
    const py = out.find(f => f.path === "pyproject.toml")!.content;
    expect(py).toContain('description = "has \\"quotes\\""');
  });

  test("workflow runs uv-based pytest with caching enabled", () => {
    const yml = byPath[".github/workflows/test.yml"]!;
    expect(yml).toContain("astral-sh/setup-uv");
    expect(yml).toContain("enable-cache: true");
    expect(yml).toContain("uv run --group dev pytest");
    expect(yml).toContain("uv python install");
  });

  test("workflow triggers on PRs and pushes to main", () => {
    const yml = byPath[".github/workflows/test.yml"]!;
    expect(yml).toMatch(/pull_request:[\s\S]*branches: \[main\]/);
    expect(yml).toMatch(/push:[\s\S]*branches: \[main\]/);
  });

  test("conftest.py defines the parametrize hook (no test functions — those live in test_solutions.py)", () => {
    const cf = byPath["solutions/conftest.py"]!;
    expect(cf).toContain("def pytest_generate_tests");
    expect(cf).toContain("def iter_problems");
    expect(cf).toContain("metafunc.parametrize");
    // No test_ functions in conftest — that would cause pytest to double-collect
    expect(cf).not.toMatch(/^def test_/m);
  });

  test("test_solutions.py contains the actual test functions and imports from conftest + helpers", () => {
    const t = byPath["solutions/test_solutions.py"]!;
    expect(t).toContain("def test_leetcode_solution");
    expect(t).toContain("def test_harness_loads");
    expect(t).toContain("from solutions.conftest import LeetCodeCase, SOLUTIONS_ROOT, load_solution");
    expect(t).toContain(
      "from solutions.helpers import UnsupportedTypeError, compare_values, parse_value"
    );
  });

  test("test_solutions.py treats void return type as in-place mutation of first arg", () => {
    const t = byPath["solutions/test_solutions.py"]!;
    expect(t).toContain('if return_type == "void"');
    expect(t).toContain("parsed_args[0]");
    expect(t).toContain("LeetCode convention");
  });

  test("helpers.py exposes ListNode, TreeNode, parse/compare, and UnsupportedTypeError", () => {
    const h = byPath["solutions/helpers.py"]!;
    expect(h).toContain("class ListNode");
    expect(h).toContain("class TreeNode");
    expect(h).toContain("class UnsupportedTypeError");
    expect(h).toContain("def parse_value");
    expect(h).toContain("def compare_values");
    expect(h).toContain("def list_to_treenode");
    expect(h).toContain("def list_to_listnode");
  });

  test("helpers.py raises UnsupportedTypeError for unrecognized types (so tests skip, not fail)", () => {
    expect(byPath["solutions/helpers.py"]).toContain('raise UnsupportedTypeError');
  });

  test(".gitignore covers the standard Python noise", () => {
    const gi = byPath[".gitignore"]!;
    expect(gi).toContain("__pycache__");
    expect(gi).toContain(".pytest_cache");
    expect(gi).toContain(".venv");
  });

  test("solutions/__init__.py is an empty marker", () => {
    expect(byPath["solutions/__init__.py"]).toBe("");
  });
});

describe("generateProblemFiles", () => {
  const baseSpec = {
    questionFrontendId: "1",
    titleSlug: "two-sum",
    title: "Two Sum",
    difficulty: "Easy",
    langExt: "py",
    code: "class Solution:\n    def twoSum(self, nums, target):\n        pass\n",
    testsJson: {
      questionId: "1",
      functionName: "twoSum",
      params: [{ name: "nums", type: "integer[]" }],
      cases: [{ input: ["[2,7]", "9"], expected: "[0,1]" }],
    },
    problemMarkdown: "Given an array of integers, return indices.",
    runtimeDisplay: "52 ms",
    memoryDisplay: "17.4 MB",
    runtimePercentile: 92.34,
    memoryPercentile: 65.12,
    topicTags: ["Array", "Hash Table"],
  };

  test("produces solution / tests.json / README under a 4-digit-padded directory", () => {
    const out = generateProblemFiles(baseSpec);
    expect(out.solutionsDir).toBe("solutions/0001-two-sum");
    expect(out.files.map(f => f.path).sort()).toEqual([
      "solutions/0001-two-sum/README.md",
      "solutions/0001-two-sum/solution.py",
      "solutions/0001-two-sum/tests.json",
    ]);
  });

  test("python solution gets the LeetCode compatibility header prepended", () => {
    const out = generateProblemFiles(baseSpec);
    const sol = out.files.find(f => f.path.endsWith("/solution.py"))!;
    expect(sol.content).toContain("class Solution");
    // User's code is preserved verbatim
    expect(sol.content).toContain(baseSpec.code);
    // Header brings in typing.* and ListNode / TreeNode
    expect(sol.content).toContain("from typing import *");
    expect(sol.content).toContain("from solutions.helpers import ListNode, TreeNode");
    // Header comes before user code
    expect(sol.content.indexOf("from typing import *")).toBeLessThan(sol.content.indexOf("class Solution"));
  });

  test("non-python langExt produces solution.<ext> at the right path with code unchanged", () => {
    const out = generateProblemFiles({ ...baseSpec, langExt: "cpp", code: "int main() {}" });
    const sol = out.files.find(f => f.path === "solutions/0001-two-sum/solution.cpp")!;
    expect(sol).toBeDefined();
    // No Python header for non-Python languages
    expect(sol.content).toBe("int main() {}");
    expect(sol.content).not.toContain("from typing");
  });

  test("tests.json is pretty-printed JSON with trailing newline", () => {
    const out = generateProblemFiles(baseSpec);
    const tj = out.files.find(f => f.path.endsWith("/tests.json"))!;
    expect(tj.content.endsWith("\n")).toBe(true);
    expect(JSON.parse(tj.content)).toEqual(baseSpec.testsJson as object);
    expect(tj.content).toContain("  ");
  });

  test("README contains title, difficulty, tags, runtime/memory stats, and source link", () => {
    const out = generateProblemFiles(baseSpec);
    const r = out.files.find(f => f.path.endsWith("/README.md"))!.content;
    expect(r).toContain("# 1. Two Sum");
    expect(r).toContain("Easy");
    expect(r).toContain("`Array`");
    expect(r).toContain("`Hash Table`");
    expect(r).toContain("52 ms");
    expect(r).toContain("17.4 MB");
    expect(r).toContain("92.34%");
    expect(r).toContain("65.12%");
    expect(r).toContain("https://leetcode.com/problems/two-sum/");
  });

  test("README run-instructions match the problem dir", () => {
    const out = generateProblemFiles(baseSpec);
    const r = out.files.find(f => f.path.endsWith("/README.md"))!.content;
    expect(r).toContain("uv run pytest solutions/0001-two-sum/");
  });

  test("README falls back when problem markdown is empty", () => {
    const out = generateProblemFiles({ ...baseSpec, problemMarkdown: "" });
    const r = out.files.find(f => f.path.endsWith("/README.md"))!.content;
    expect(r).toContain("Problem statement was not captured");
  });

  test("README handles missing tags gracefully", () => {
    const out = generateProblemFiles({ ...baseSpec, topicTags: [] });
    const r = out.files.find(f => f.path.endsWith("/README.md"))!.content;
    expect(r).toContain("_no tags_");
  });

  test("does not double-wrap if code already has the compatibility header (re-sync safety)", () => {
    const onceWrapped = wrapForLanguage(baseSpec.code, "py");
    const twiceWrapped = wrapForLanguage(onceWrapped, "py");
    expect(twiceWrapped).toBe(onceWrapped);
  });

  test("zero-pads ids of various lengths", () => {
    expect(generateProblemFiles({ ...baseSpec, questionFrontendId: "1" }).solutionsDir).toBe(
      "solutions/0001-two-sum"
    );
    expect(generateProblemFiles({ ...baseSpec, questionFrontendId: "42" }).solutionsDir).toBe(
      "solutions/0042-two-sum"
    );
    expect(generateProblemFiles({ ...baseSpec, questionFrontendId: "12345" }).solutionsDir).toBe(
      "solutions/12345-two-sum"
    );
  });
});
