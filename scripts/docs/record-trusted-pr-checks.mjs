const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
const token = process.env.GITHUB_TOKEN;

const checks = [
  ["package-examples", "Package examples against local API"],
  ["typecheck", "Typecheck and unit tests"],
  ["api-e2e", "REST API end to end"],
  ["static-export", "Static export build"],
  ["docs", "Check and build docs"],
  ["title", "Conventional commit"],
];

async function apiRequest(repo, resource, { method = "GET", body } = {}) {
  const response = await fetch(`${apiUrl}/repos/${repo}/${resource}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`GitHub API ${method} ${resource} failed (${response.status}): ${JSON.stringify(result)}`);
  return result;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const repo = required("EXPECTED_REPO");
  const prNumber = required("EXPECTED_PULL_REQUEST");
  const expectedSha = required("EXPECTED_HEAD_SHA");
  const defaultBranch = required("EXPECTED_DEFAULT_BRANCH");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid repository name");
  if (!/^\d+$/.test(prNumber)) throw new Error("Invalid pull request number");
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error("Invalid expected commit SHA");
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  const title = Buffer.from(required("EXPECTED_TITLE_B64"), "base64").toString("utf8");
  const pr = await apiRequest(repo, `pulls/${prNumber}`);
  const openOrMerged = pr.state === "open" || (pr.state === "closed" && pr.merged === true);
  if (!openOrMerged || pr.head?.repo?.full_name !== repo || pr.base?.repo?.full_name !== repo
    || pr.base?.ref !== defaultBranch || pr.head?.ref === defaultBranch || pr.head?.sha !== expectedSha || pr.title !== title) {
    console.log(`Trusted PR checks not recorded: pull request #${prNumber} is closed, changed, or no longer matches expected SHA/title/base.`);
    return;
  }

  const conclusions = JSON.parse(required("CHECK_RESULTS"));
  for (const [key, name] of checks) {
    const result = conclusions[key];
    if (!["success", "failure", "cancelled", "skipped"].includes(result)) {
      throw new Error(`Missing or invalid result for ${key}: ${result}`);
    }
    const conclusion = result === "success" ? "success" : result === "cancelled" ? "cancelled" : "failure";
    await apiRequest(repo, "check-runs", {
      method: "POST",
      body: {
        name,
        head_sha: expectedSha,
        status: "completed",
        conclusion,
        output: {
          title: name,
          summary: `Trusted default-branch validation result: ${result}. The PR source was checked out at ${expectedSha} with read-only repository permissions.`,
        },
      },
    });
  }
  console.log(`Recorded ${checks.length} trusted check results on ${expectedSha}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
