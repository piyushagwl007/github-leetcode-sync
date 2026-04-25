# github-leetcode-sync

A Brave / Chrome extension that automatically commits your accepted LeetCode submissions to a GitHub repository, opening a pull request per submission and auto-merging once tests pass — so your contribution graph reflects your practice.

## Status

Work in progress.

## Stack

- TypeScript
- Bun (package manager + bundler)
- Chrome Manifest V3
- GitHub REST + GraphQL APIs
- LeetCode internal GraphQL API (uses your existing browser session)

## How it will work

1. While you solve on `leetcode.com`, the extension detects an accepted submission.
2. It pulls the submitted code, problem statement, and example test cases from LeetCode.
3. It creates a branch in your sync repo, commits a runnable Python solution + `tests.json` + per-problem README, and opens a pull request.
4. CI runs `uv run pytest` against the new problem; if green, the PR auto-merges to `main`.
5. The merge commit lands as a contribution on your GitHub profile.

## Setup

Setup instructions will be documented once the first version is functional.
