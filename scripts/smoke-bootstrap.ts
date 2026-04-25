// Smoke test: emits the bootstrap files + a real Two Sum problem into a temp
// directory and runs `uv run pytest` against them. Verifies the generated
// Python harness actually executes (catches syntax errors and logic bugs the
// TypeScript unit tests cannot).
//
// Not part of CI (would require uv on the runner). Run manually:
//   bun run scripts/smoke-bootstrap.ts

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { generateBootstrapFiles, generateProblemFiles } from "../src/lib/repo-bootstrap";

const tmpRoot = join(tmpdir(), `glc-smoke-${Date.now()}`);

async function writeFiles(files: Array<{ path: string; content: string }>) {
  for (const f of files) {
    const full = join(tmpRoot, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content);
  }
}

await rm(tmpRoot, { recursive: true, force: true });
await mkdir(tmpRoot, { recursive: true });

await writeFiles(
  generateBootstrapFiles({ projectName: "smoke-test", description: "smoke" })
);

const twoSumCode = `class Solution:
    def twoSum(self, nums, target):
        seen = {}
        for i, n in enumerate(nums):
            if target - n in seen:
                return [seen[target - n], i]
            seen[n] = i
        return []
`;

const problem = generateProblemFiles({
  questionFrontendId: "1",
  titleSlug: "two-sum",
  title: "Two Sum",
  difficulty: "Easy",
  langExt: "py",
  code: twoSumCode,
  testsJson: {
    questionId: "1",
    title: "Two Sum",
    titleSlug: "two-sum",
    difficulty: "Easy",
    functionName: "twoSum",
    params: [
      { name: "nums", type: "integer[]" },
      { name: "target", type: "integer" },
    ],
    returnType: "integer[]",
    cases: [
      { input: ["[2,7,11,15]", "9"], expected: "[0,1]" },
      { input: ["[3,2,4]", "6"], expected: "[1,2]" },
      { input: ["[3,3]", "6"], expected: "[0,1]" },
    ],
  },
  problemMarkdown: "Find two indices that sum to target.",
  runtimeDisplay: "0 ms",
  memoryDisplay: "0 MB",
  runtimePercentile: 0,
  memoryPercentile: 0,
  topicTags: ["Array", "Hash Table"],
});
await writeFiles(problem.files);

// Second problem: a void-return / in-place mutation problem (Sort Colors).
// Verifies the harness compares the mutated first arg, not the return value.
const sortColorsCode = `class Solution:
    def sortColors(self, nums: List[int]) -> None:
        nums.sort()
`;

const sortColors = generateProblemFiles({
  questionFrontendId: "75",
  titleSlug: "sort-colors",
  title: "Sort Colors",
  difficulty: "Medium",
  langExt: "py",
  code: sortColorsCode,
  testsJson: {
    questionId: "75",
    title: "Sort Colors",
    titleSlug: "sort-colors",
    difficulty: "Medium",
    functionName: "sortColors",
    params: [{ name: "nums", type: "integer[]" }],
    returnType: "void",
    cases: [
      { input: ["[2,0,2,1,1,0]"], expected: "[0,0,1,1,2,2]" },
      { input: ["[2,0,1]"], expected: "[0,1,2]" },
    ],
  },
  problemMarkdown: "Sort an array of 0/1/2 in place.",
  runtimeDisplay: "0 ms",
  memoryDisplay: "0 MB",
  runtimePercentile: 0,
  memoryPercentile: 0,
  topicTags: ["Array", "Two Pointers", "Sorting"],
});
await writeFiles(sortColors.files);

console.log(`Wrote bootstrap + Two Sum + Sort Colors to ${tmpRoot}`);
console.log("Running: uv run --group dev pytest");

const proc = Bun.spawnSync({
  cmd: ["uv", "run", "--group", "dev", "pytest", "-v"],
  cwd: tmpRoot,
  stdout: "inherit",
  stderr: "inherit",
});

if (proc.exitCode !== 0) {
  console.error(`\npytest failed with exit ${proc.exitCode}`);
  console.error(`Inspect: ${tmpRoot}`);
  process.exit(proc.exitCode ?? 1);
}

console.log("\nSmoke test passed. Cleaning up.");
await rm(tmpRoot, { recursive: true, force: true });
