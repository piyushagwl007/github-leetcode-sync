// LeetCode GraphQL client. Talks to leetcode.com/graphql using the user's
// existing browser cookies. Designed for use from the background service worker.

const GRAPHQL_URL = "https://leetcode.com/graphql";

const LANG_TO_EXT: Record<string, string> = {
  cpp: "cpp",
  java: "java",
  python: "py",
  python3: "py",
  c: "c",
  csharp: "cs",
  javascript: "js",
  typescript: "ts",
  php: "php",
  swift: "swift",
  kotlin: "kt",
  dart: "dart",
  golang: "go",
  ruby: "rb",
  scala: "scala",
  rust: "rs",
  racket: "rkt",
  erlang: "erl",
  elixir: "ex",
  mysql: "sql",
  mssql: "sql",
  oraclesql: "sql",
  postgresql: "sql",
  bash: "sh",
};

export function extensionForLang(lang: string | null | undefined): string {
  if (!lang) return "txt";
  return LANG_TO_EXT[lang.toLowerCase()] ?? "txt";
}

export interface RecentAcSubmission {
  id: string;
  title: string;
  titleSlug: string;
  timestamp: string;
  lang: string;
}

export interface SubmissionDetail {
  runtime: number;
  runtimeDisplay: string;
  runtimePercentile: number;
  memory: number;
  memoryDisplay: string;
  memoryPercentile: number;
  code: string;
  timestamp: number;
  statusCode: number;
  lang: { name: string; verboseName: string };
  question: {
    questionId: string;
    questionFrontendId: string;
    titleSlug: string;
    title: string;
    difficulty: string;
  };
}

export interface ProblemMeta {
  questionFrontendId: string;
  title: string;
  titleSlug: string;
  difficulty: string;
  content: string;
  topicTags: Array<{ name: string; slug: string }>;
  sampleTestCase: string | null;
  exampleTestcaseList: string[] | null;
  metaData: string | null;
}

export interface TestsJson {
  questionId: string;
  title: string;
  titleSlug: string;
  difficulty: string;
  functionName: string | null;
  params: Array<{ name: string; type: string }>;
  returnType: string | null;
  cases: Array<{ input: string[]; expected: string | null }>;
}

// Minimal injection seam: lets tests stub fetch + cookie lookup without
// touching globals. Production wiring is done in background.ts.
export interface LeetCodeDeps {
  fetchFn: typeof fetch;
  getCookie: (name: string) => Promise<string | null>;
}

export function createLeetCodeClient(deps: LeetCodeDeps) {
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const csrf = await deps.getCookie("csrftoken");
    const res = await deps.fetchFn(GRAPHQL_URL, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-csrftoken": csrf ?? "",
        Referer: "https://leetcode.com",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`LeetCode GraphQL ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join("; "));
    if (!json.data) throw new Error("LeetCode GraphQL returned no data");
    return json.data;
  }

  async function fetchUsername(): Promise<string | null> {
    const data = await gql<{ userStatus: { username: string; isSignedIn: boolean } | null }>(
      `query globalData { userStatus { username isSignedIn } }`,
      {}
    );
    if (!data.userStatus?.isSignedIn) return null;
    return data.userStatus.username;
  }

  async function fetchRecentAcSubmissions(username: string, limit = 20): Promise<RecentAcSubmission[]> {
    const data = await gql<{ recentAcSubmissionList: RecentAcSubmission[] | null }>(
      `query recentAcSubmissions($username: String!, $limit: Int!) {
        recentAcSubmissionList(username: $username, limit: $limit) {
          id title titleSlug timestamp lang
        }
      }`,
      { username, limit }
    );
    return data.recentAcSubmissionList ?? [];
  }

  async function fetchSubmissionDetail(submissionId: string | number): Promise<SubmissionDetail | null> {
    const data = await gql<{ submissionDetails: SubmissionDetail | null }>(
      `query submissionDetails($submissionId: Int!) {
        submissionDetails(submissionId: $submissionId) {
          runtime runtimeDisplay runtimePercentile
          memory memoryDisplay memoryPercentile
          code timestamp statusCode
          lang { name verboseName }
          question {
            questionId questionFrontendId titleSlug title difficulty
          }
        }
      }`,
      { submissionId: Number(submissionId) }
    );
    return data.submissionDetails ?? null;
  }

  async function fetchProblemMeta(titleSlug: string): Promise<ProblemMeta | null> {
    const data = await gql<{ question: ProblemMeta | null }>(
      `query questionData($titleSlug: String!) {
        question(titleSlug: $titleSlug) {
          questionFrontendId title titleSlug difficulty content
          topicTags { name slug }
          sampleTestCase exampleTestcaseList metaData
        }
      }`,
      { titleSlug }
    );
    return data.question ?? null;
  }

  return { fetchUsername, fetchRecentAcSubmissions, fetchSubmissionDetail, fetchProblemMeta };
}

// Pull the example output values out of a LeetCode problem's HTML content.
// LeetCode renders examples as:
//
//   <p><strong class="example">Example 1:</strong></p>
//   <pre><strong>Input:</strong> nums = [2,7,11,15], target = 9
//   <strong>Output:</strong> [0,1]
//   <strong>Explanation:</strong> ...
//   </pre>
//
// We capture everything after `<strong>Output:</strong>` until the next
// `<strong>` tag, end of `<pre>`, or end of line — whichever comes first.
// Returned in document order so it lines up with exampleTestcaseList.
export function extractExampleOutputs(html: string | null | undefined): string[] {
  if (!html) return [];
  const results: string[] = [];
  const re = /<strong[^>]*>\s*Output\s*\d*\s*:\s*<\/strong>([^]*?)(?=<strong|<\/pre>|\r?\n\s*\r?\n|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1] ?? "";
    const cleaned = raw
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\r?\n.*$/s, "")
      .trim();
    if (cleaned) results.push(cleaned);
  }
  return results;
}

// HTML → readable markdown-ish text for the per-problem README.
export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<\/?(strong|b)>/gi, "**")
    .replace(/<\/?(em|i)>/gi, "*")
    .replace(/<code>/gi, "`")
    .replace(/<\/code>/gi, "`")
    .replace(/<pre>/gi, "\n```\n")
    .replace(/<\/pre>/gi, "\n```\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<li>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Build the language-agnostic tests.json from question metadata.
//
// LeetCode's `metaData` is a JSON string like:
//   {"name":"twoSum","params":[{"name":"nums","type":"integer[]"},...],"return":{"type":"integer[]"}}
// `exampleTestcaseList` is an array of newline-joined input strings, one per case.
export function buildTestsJson(question: ProblemMeta, expectedOutputs: Array<string | null> = []): TestsJson {
  let meta: { name?: string; params?: Array<{ name: string; type: string }>; return?: { type: string } } = {};
  try {
    meta = question.metaData ? JSON.parse(question.metaData) : {};
  } catch {
    meta = {};
  }

  const rawCases = question.exampleTestcaseList?.length
    ? question.exampleTestcaseList
    : question.sampleTestCase
    ? [question.sampleTestCase]
    : [];

  const cases = rawCases.map((raw, i) => ({
    input: raw.split("\n"),
    expected: expectedOutputs[i] ?? null,
  }));

  return {
    questionId: question.questionFrontendId,
    title: question.title,
    titleSlug: question.titleSlug,
    difficulty: question.difficulty,
    functionName: meta.name ?? null,
    params: meta.params ?? [],
    returnType: meta.return?.type ?? null,
    cases,
  };
}

// "0001-two-sum" — predictable directory name for the synced repo.
export function problemDirName(questionFrontendId: string, titleSlug: string): string {
  return `${questionFrontendId.padStart(4, "0")}-${titleSlug}`;
}
