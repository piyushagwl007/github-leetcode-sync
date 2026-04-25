// Generates the file contents committed into the *synced* repo (the one that
// holds your LeetCode solutions). Two surfaces:
//
//   generateBootstrapFiles  — one-time scaffold: pyproject.toml, conftest.py,
//                             helpers.py, GitHub Actions workflow, README.
//   generateProblemFiles    — per-submission: solution.py, tests.json, README.md
//
// Kept as pure functions returning { path, content } objects so the GitHub
// client can commit them atomically without coupling.

export interface BootstrapFile {
  path: string;
  content: string;
}

export function generateBootstrapFiles(opts: {
  projectName: string;
  description?: string;
}): BootstrapFile[] {
  return [
    { path: "README.md", content: rootReadme(opts) },
    { path: "pyproject.toml", content: pyproject(opts) },
    { path: ".gitignore", content: PYTHON_GITIGNORE },
    { path: ".github/workflows/test.yml", content: TEST_WORKFLOW },
    { path: "solutions/__init__.py", content: "" },
    { path: "solutions/conftest.py", content: CONFTEST_PY },
    { path: "solutions/test_solutions.py", content: TEST_SOLUTIONS_PY },
    { path: "solutions/helpers.py", content: HELPERS_PY },
  ];
}

export interface ProblemSpec {
  questionFrontendId: string;
  titleSlug: string;
  title: string;
  difficulty: string;
  langExt: string;
  code: string;
  testsJson: unknown;
  problemMarkdown: string;
  runtimeDisplay: string;
  memoryDisplay: string;
  runtimePercentile: number;
  memoryPercentile: number;
  topicTags: string[];
}

export interface ProblemFiles {
  solutionsDir: string;
  files: BootstrapFile[];
}

export function generateProblemFiles(spec: ProblemSpec): ProblemFiles {
  const dir = `solutions/${spec.questionFrontendId.padStart(4, "0")}-${spec.titleSlug}`;
  return {
    solutionsDir: dir,
    files: [
      { path: `${dir}/solution.${spec.langExt}`, content: wrapForLanguage(spec.code, spec.langExt) },
      { path: `${dir}/tests.json`, content: JSON.stringify(spec.testsJson, null, 2) + "\n" },
      { path: `${dir}/README.md`, content: problemReadme(spec) },
    ],
  };
}

// LeetCode's Python judge auto-injects standard imports (typing, collections,
// math, etc.) and provides ListNode / TreeNode in scope. Submitted code
// relies on these without importing them, so it fails locally with
// NameError. We prepend the same imports so the file is runnable as-is.
const PYTHON_COMPAT_HEADER = `# Standard library imports that LeetCode's Python judge auto-injects.
# Prepended by github-leetcode-sync so the solution is runnable locally.
from typing import *  # noqa: F401,F403
from collections import *  # noqa: F401,F403
import math  # noqa: F401
import heapq  # noqa: F401
import bisect  # noqa: F401
import functools  # noqa: F401
import itertools  # noqa: F401
import operator  # noqa: F401
import string  # noqa: F401

from solutions.helpers import ListNode, TreeNode  # noqa: F401

`;

const COMPAT_HEADER_MARKER = "github-leetcode-sync so the solution is runnable";

export function wrapForLanguage(code: string, langExt: string): string {
  if (langExt === "py") {
    if (code.includes(COMPAT_HEADER_MARKER)) return code;
    return PYTHON_COMPAT_HEADER + code;
  }
  return code;
}

// -- README templates -------------------------------------------------------

function rootReadme(opts: { projectName: string; description?: string }): string {
  return `# ${opts.projectName}

${opts.description ?? "Auto-synced LeetCode solutions with a runnable Python test harness."}

## Layout

\`\`\`
solutions/
  conftest.py        # pytest harness, auto-discovers tests.json next to each solution.py
  helpers.py         # ListNode, TreeNode, type parsing, value comparison
  0001-two-sum/
    solution.py
    tests.json
    README.md
\`\`\`

Each problem directory contains the submitted solution, the example test cases captured from LeetCode, and a generated README with the problem statement and your runtime/memory stats.

## Running the tests

This project uses [\`uv\`](https://docs.astral.sh/uv/) for environment management.

\`\`\`bash
# Run every test
uv run pytest

# Run one problem
uv run pytest solutions/0001-two-sum/

# Run with verbose output
uv run pytest -v
\`\`\`

CI runs the same on every pull request. PRs auto-merge once the test job passes.

## How solutions are added

A browser extension running on \`leetcode.com\` watches for accepted submissions, captures the code and metadata, and opens a pull request to this repo. CI runs the example test cases against the submitted code; if green, auto-merge lands the commit on \`main\`.
`;
}

function problemReadme(spec: ProblemSpec): string {
  const tags = spec.topicTags.length ? spec.topicTags.map(t => `\`${t}\``).join(" · ") : "_no tags_";
  return `# ${spec.questionFrontendId}. ${spec.title}

**Difficulty:** ${spec.difficulty}
**Tags:** ${tags}
**Runtime:** ${spec.runtimeDisplay} (faster than ${spec.runtimePercentile.toFixed(2)}%)
**Memory:** ${spec.memoryDisplay} (less than ${spec.memoryPercentile.toFixed(2)}%)
**Source:** https://leetcode.com/problems/${spec.titleSlug}/

---

## Problem

${spec.problemMarkdown.trim() || "_Problem statement was not captured._"}

## Run

\`\`\`bash
uv run pytest solutions/${spec.questionFrontendId.padStart(4, "0")}-${spec.titleSlug}/
\`\`\`
`;
}

// -- Project files ----------------------------------------------------------

function pyproject(opts: { projectName: string; description?: string }): string {
  return `[project]
name = "${opts.projectName}"
version = "0.1.0"
description = ${JSON.stringify(opts.description ?? "Auto-synced LeetCode solutions.")}
requires-python = ">=3.11"
dependencies = []

[dependency-groups]
dev = [
    "pytest>=8.0",
]

[tool.pytest.ini_options]
testpaths = ["solutions"]
addopts = "-ra"
`;
}

const PYTHON_GITIGNORE = `__pycache__/
*.py[cod]
*$py.class
.pytest_cache/
.venv/
.python-version
*.egg-info/
build/
dist/
.coverage
.DS_Store
`;

const TEST_WORKFLOW = `name: tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    name: pytest
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install uv
        uses: astral-sh/setup-uv@v6
        with:
          enable-cache: true

      - name: Set up Python
        run: uv python install 3.11

      - name: Run tests
        run: uv run --group dev pytest
`;

// -- Python harness ---------------------------------------------------------
//
// conftest.py auto-discovers every problem directory under solutions/, loads
// its tests.json, parametrizes one pytest case per example input, dynamically
// imports the Solution class from solution.py, and asserts the result.
//
// Tests are skipped (not failed) when:
//   - tests.json has no functionName (older problems / scraping miss)
//   - the example case has no expected output captured
//   - a parameter type is not yet supported by helpers.parse_value
//
// This keeps CI green for half-instrumented submissions while still catching
// regressions for the common case (numeric / array / string / linked-list /
// tree problems).

const CONFTEST_PY = `"""Pytest collection hook: discovers each problem directory and parametrizes
one case per example input. The actual test functions live in test_solutions.py
(separating them avoids pytest collecting conftest.py as a test module).
"""

from __future__ import annotations

import importlib.util
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator


SOLUTIONS_ROOT = Path(__file__).parent


@dataclass
class LeetCodeCase:
    problem_dir: Path
    spec: dict
    case_index: int
    case: dict


def iter_problems() -> Iterator[Path]:
    for entry in sorted(SOLUTIONS_ROOT.iterdir()):
        if not entry.is_dir():
            continue
        if (entry / "solution.py").exists() and (entry / "tests.json").exists():
            yield entry


def load_solution(problem_dir: Path) -> Any:
    sol_path = problem_dir / "solution.py"
    spec = importlib.util.spec_from_file_location(
        f"solutions.{problem_dir.name}.solution", sol_path
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {sol_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "Solution"):
        raise AttributeError(f"{sol_path} has no Solution class")
    return module.Solution()


def _collect_cases() -> list[LeetCodeCase]:
    cases: list[LeetCodeCase] = []
    for problem_dir in iter_problems():
        spec = json.loads((problem_dir / "tests.json").read_text())
        for i, case in enumerate(spec.get("cases", [])):
            cases.append(LeetCodeCase(problem_dir, spec, i, case))
    return cases


def pytest_generate_tests(metafunc):
    if "leetcode_case" not in metafunc.fixturenames:
        return
    cases = _collect_cases()
    metafunc.parametrize(
        "leetcode_case",
        cases,
        ids=[f"{c.problem_dir.name}[{c.case_index}]" for c in cases],
    )
`;

const TEST_SOLUTIONS_PY = `"""Runs every parametrized LeetCode case discovered by conftest.py."""

from __future__ import annotations

import json
from typing import Any

import pytest

from solutions.conftest import LeetCodeCase, SOLUTIONS_ROOT, load_solution
from solutions.helpers import UnsupportedTypeError, compare_values, parse_value


def test_harness_loads() -> None:
    """Sentinel test: keeps CI green on a freshly bootstrapped repo before any problems are synced."""
    assert SOLUTIONS_ROOT.exists()


def test_leetcode_solution(leetcode_case: LeetCodeCase) -> None:
    spec = leetcode_case.spec
    case = leetcode_case.case

    function_name = spec.get("functionName")
    if not function_name:
        pytest.skip("no functionName captured")

    expected_raw = case.get("expected")
    if expected_raw is None:
        pytest.skip("no expected output captured")

    params = spec.get("params") or []
    inputs = case.get("input") or []
    if len(inputs) != len(params):
        pytest.skip(f"input/param count mismatch ({len(inputs)} vs {len(params)})")

    parsed_args: list[Any] = []
    for raw, param in zip(inputs, params):
        try:
            parsed_args.append(parse_value(raw, param.get("type")))
        except UnsupportedTypeError as e:
            pytest.skip(str(e))
        except (ValueError, json.JSONDecodeError) as e:
            pytest.skip(f"could not parse input {raw!r} as {param.get('type')!r}: {e}")

    return_type = spec.get("returnType")
    try:
        expected = parse_value(expected_raw, return_type)
    except UnsupportedTypeError as e:
        pytest.skip(str(e))
    except (ValueError, json.JSONDecodeError) as e:
        pytest.skip(f"could not parse expected output {expected_raw!r} as {return_type!r}: {e}")

    solution = load_solution(leetcode_case.problem_dir)
    method = getattr(solution, function_name)
    actual = method(*parsed_args)

    assert compare_values(actual, expected, return_type), (
        f"input={inputs!r} expected={expected_raw!r} got={actual!r}"
    )
`;

const HELPERS_PY = `"""Type parsing and equality for LeetCode's example test cases.

LeetCode's question metadata declares parameter types as strings like:
    integer, integer[], integer[][], string, string[], boolean, double,
    character, character[][], ListNode, TreeNode, void

For the JSON-serializable subset we just route through json.loads. ListNode
and TreeNode get bespoke parsing/serialization. Anything else raises
UnsupportedTypeError so the test is skipped (not failed) — keeps CI green
for problems with exotic types until we add support.
"""

from __future__ import annotations

import json
import math
from typing import Any, Optional


class UnsupportedTypeError(Exception):
    """Raised when a LeetCode type is not yet handled by the harness."""


class ListNode:
    def __init__(self, val: int = 0, next: Optional["ListNode"] = None) -> None:
        self.val = val
        self.next = next


class TreeNode:
    def __init__(
        self,
        val: int = 0,
        left: Optional["TreeNode"] = None,
        right: Optional["TreeNode"] = None,
    ) -> None:
        self.val = val
        self.left = left
        self.right = right


_JSON_BASES = {
    "integer",
    "long",
    "double",
    "float",
    "string",
    "boolean",
    "character",
    "void",
}


def parse_value(raw: str, type_str: Optional[str]) -> Any:
    """Parse a raw LeetCode input string according to its declared type."""
    if type_str is None:
        return json.loads(raw)

    t = type_str.strip()

    if t.startswith("ListNode"):
        return list_to_listnode(json.loads(raw))
    if t.startswith("TreeNode"):
        return list_to_treenode(json.loads(raw))

    base = t.replace("[]", "").lower()
    if base in _JSON_BASES:
        return json.loads(raw)

    raise UnsupportedTypeError(f"unsupported type: {type_str}")


def list_to_listnode(values: list[int]) -> Optional[ListNode]:
    if not values:
        return None
    head = ListNode(values[0])
    curr = head
    for v in values[1:]:
        curr.next = ListNode(v)
        curr = curr.next
    return head


def listnode_to_list(node: Optional[ListNode]) -> list[int]:
    out: list[int] = []
    while node is not None:
        out.append(node.val)
        node = node.next
    return out


def list_to_treenode(values: list[Optional[int]]) -> Optional[TreeNode]:
    if not values:
        return None
    if values[0] is None:
        return None
    root = TreeNode(values[0])
    queue: list[TreeNode] = [root]
    i = 1
    while queue and i < len(values):
        node = queue.pop(0)
        if i < len(values) and values[i] is not None:
            node.left = TreeNode(values[i])  # type: ignore[arg-type]
            queue.append(node.left)
        i += 1
        if i < len(values) and values[i] is not None:
            node.right = TreeNode(values[i])  # type: ignore[arg-type]
            queue.append(node.right)
        i += 1
    return root


def treenode_to_list(root: Optional[TreeNode]) -> list[Optional[int]]:
    if root is None:
        return []
    out: list[Optional[int]] = []
    queue: list[Optional[TreeNode]] = [root]
    while queue:
        node = queue.pop(0)
        if node is None:
            out.append(None)
        else:
            out.append(node.val)
            queue.append(node.left)
            queue.append(node.right)
    while out and out[-1] is None:
        out.pop()
    return out


def compare_values(actual: Any, expected: Any, type_str: Optional[str]) -> bool:
    """Compare a solution's return value against the expected output."""
    if type_str is not None:
        t = type_str.strip()
        if t.startswith("ListNode"):
            return listnode_to_list(actual) == (
                expected if isinstance(expected, list) else listnode_to_list(expected)
            )
        if t.startswith("TreeNode"):
            actual_list = actual if isinstance(actual, list) else treenode_to_list(actual)
            expected_list = (
                expected if isinstance(expected, list) else treenode_to_list(expected)
            )
            return actual_list == expected_list
        if t in {"double", "float"}:
            return _floats_equal(actual, expected)

    if isinstance(actual, float) or isinstance(expected, float):
        return _floats_equal(actual, expected)

    return actual == expected


def _floats_equal(a: float, b: float, tol: float = 1e-5) -> bool:
    if math.isnan(a) or math.isnan(b):
        return math.isnan(a) and math.isnan(b)
    return abs(a - b) <= tol
`;
