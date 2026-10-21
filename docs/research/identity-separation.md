# Identity separation for verification vs. implementation on GitHub

Research brief for issue
[#178](https://github.com/constructorfleet/SketchForge-3D/issues/178) (child of
map issue #169). **This is a factual brief, not a recommendation.** It
establishes what is available, what is verifiable from primary sources, and
where the enforcement ceiling actually sits. Downstream tickets make the choice.

- **Scope of the question**: what a solo maintainer with one machine and one
  token can use to separate a *verification* identity from an *implementation*
  identity, given the spec's requirements for distinct credentials (R-2.1),
  environment-enforced `forbidden_reads` (R-2.9), and a publishing/state-owning
  identity unreachable from workflows that execute PR-authored code (R-7.2,
  R-7.3).
- **Source discipline**: every claim below cites either `docs.github.com` or
  GitHub's own published OpenAPI description
  ([`github/rest-api-description`](https://github.com/github/rest-api-description)),
  which is the normative schema behind the REST reference. Claims that could not
  be grounded in a primary source are marked **NOT ESTABLISHED** rather than
  inferred.
- **Live evidence**: claims testable against this repository were tested with
  read-only `gh api` calls on 2026-10-21 and the actual output is recorded.

## 0. A premise correction, established by direct observation

The ticket frames the problem as a solo maintainer "without an organization."
That is not the configuration this repository is in, and the difference is
load-bearing for sections 1, 2, and 4.

```console
$ gh api repos/constructorfleet/SketchForge-3D \
    --jq '{private,owner:.owner.login,owner_type:.owner.type,visibility,fork}'
{"fork":true,"owner":"constructorfleet","owner_type":"Organization","private":false,"visibility":"public"}

$ gh api orgs/constructorfleet --jq '{login,plan:.plan.name,type}'
{"login":"constructorfleet","plan":"team","type":"Organization"}

$ gh api repos/constructorfleet/SketchForge-3D/collaborators \
    --jq '.[]|{login,type,role:.role_name}'
{"login":"Teagan42","role":"admin","type":"User"}
{"login":"ajanis","role":"admin","type":"User"}

$ gh api user/memberships/orgs/constructorfleet --jq '{role,state}'
{"role":"admin","state":"active"}
```

Three facts follow, and they widen the option space relative to the ticket's
assumption:

1. The repository is **org-owned on the Team plan**, so organization-level
   rulesets and organization Projects are available.
2. There is a **second human admin** (`ajanis`), so "one human" is an assumption
   about *who is willing to participate*, not a platform constraint.
3. The acting token's user (`Teagan42`) is **both repo admin and org admin**,
   which is precisely the condition that collapses the org-level escape hatch
   described in section 4.

The repository is also a fork (`"fork": true`) of `Formsmith746/SketchForge-3D`,
which matters for one specific ruleset inheritance rule noted in section 4.

## 1. GitHub Apps

### Can a personal account own and install an App?

**VERIFIED.** "GitHub Apps can be installed directly on organizations and
personal accounts and granted access to specific repositories."
([About creating GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps))
An App owned by a personal account installed on the owner's own repository is
therefore the minimum viable setup; no organization is required for the App
itself.

### Permissions needed for the spec's API surface

All four of the API surfaces the ticket names exist and are App-callable. From
GitHub's published OpenAPI description, each endpoint carries
`"enabledForGitHubApps": true`:

| Surface | Endpoint | Required fine-grained permission |
|---|---|---|
| Issues | `POST/PATCH /repos/{o}/{r}/issues` | `Issues` (write) |
| Sub-issues | `POST /repos/{o}/{r}/issues/{n}/sub_issues` | `Issues` (write) |
| Sub-issue reorder | `PATCH .../sub_issues/priority` | `Issues` (write) |
| Issue dependencies | `POST .../dependencies/blocked_by` | `Issues` (write) |
| Check runs | `POST /repos/{o}/{r}/check-runs` | `Checks` (write) |

Sub-issues and issue dependencies are both **real, documented REST surfaces** —
worth stating because the ticket asked them to be verified rather than assumed.
The permission strings are quoted from the endpoint reference pages:

- Sub-issues: *"The fine-grained token must have the following permission set:
  'Issues' repository permissions (write)"* —
  [REST: sub-issues](https://docs.github.com/en/rest/issues/sub-issues)
- Issue dependencies: *"The fine-grained token must have the following
  permission set: 'Issues' repository permissions (write)"* —
  [REST: issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies)
- Check runs: `POST /repos/{owner}/{repo}/check-runs` requires `checks:write`
  ([REST: check runs](https://docs.github.com/en/rest/checks/runs)); the
  `checks` permission is defined in the `app-permissions` schema as *"The level
  of permission to grant the access token for checks on code"* with values
  `read`, `write`.

### Projects V2 — the one real gap

**VERIFIED, and it is a constraint, not a formality.** GitHub's Projects
automation documentation states plainly:

> `GITHUB_TOKEN` is scoped to the repository level and cannot access projects.
> To access projects you can either create a GitHub App (recommended for
> organization projects) or a personal access token (recommended for user
> projects).
>
> You must give permission to read and write organization projects; permission
> to read and write repository projects will not be sufficient.

([Automating projects using Actions](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions))

Two consequences:

- The default `GITHUB_TOKEN` **cannot** touch Projects V2 at all. Any
  Projects-V2-mediated state is already outside what Actions can do without a
  second credential — so for Projects specifically, a separate identity is not
  a design preference, it is a prerequisite.
- The App route is documented as the path for **organization** projects, with a
  PAT recommended for **user** projects. The `app-permissions` schema exposes
  `organization_projects` (`read`/`write`/`admin`) and `repository_projects`,
  and has **no** generic user-project permission. Because this repo is
  org-owned (section 0), the App route is available here. For a genuinely
  user-owned project, the App route is **NOT ESTABLISHED** by primary docs, and
  the docs instead point at a PAT — which is the same human identity, defeating
  the separation.

### Installation token mechanics

**VERIFIED.** A JWT signed with the App's private key is exchanged at
`POST /app/installations/{installation_id}/access_tokens`; the response
"will include an installation access token, the time that the token expires, the
permissions that the token has, and the repositories that the token can access,"
and "**The installation access token will expire after 1 hour.**"
([Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation))
The token can be scoped down to a subset of the installation's repositories and
permissions at mint time, which is directly useful for R-2.9-style narrowing.

Inside Actions, this is a documented first-party flow — notable because the
ticket asked whether `actions/create-github-app-token` is primary-sourced. It
is, on `docs.github.com`:

> The following example workflow uses the `actions/create-github-app-token`
> action to generate an installation access token. [...] If you prefer to not use
> this action, you can fork and modify the `actions/create-github-app-token`
> action, or you can write a script to make your workflow create an installation
> token manually.

([Making authenticated API requests with a GitHub App in a GitHub Actions workflow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow))

### Can the App token be withheld from untrusted workflow contexts?

**VERIFIED — and this is the strongest genuinely-enforced guarantee in the whole
brief.** Minting an installation token in a workflow requires the App's private
key, which must live in a secret. GitHub states:

> With the exception of `GITHUB_TOKEN`, secrets are not passed to the runner when
> a workflow is triggered from a forked repository.
>
> The `GITHUB_TOKEN` has read-only permissions in pull requests from forked
> repositories.

([Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets))

So a `pull_request`-triggered workflow running a fork contributor's code
**cannot** obtain the App private key and **cannot** mint the verification
identity's token. This is platform-enforced, not convention.

The documented way to lose that guarantee is equally explicit:

> The `pull_request_target` and `workflow_run` workflow triggers, when used with
> the checkout of an untrusted pull request, expose the repository to security
> compromises. [...] Workflows that use these triggers must not explicitly check
> out untrusted code, including from pull request forks or from repositories that
> are not under your control.

([Security hardening / secure use](https://docs.github.com/en/actions/reference/security/secure-use))

The same page notes self-hosted runners "do not have guarantees around running
in ephemeral clean virtual machines, and can be persistently compromised by
untrusted code in a workflow" — so the fork-secret guarantee is conditional on
GitHub-hosted runners.

**Important limit on scope**: this protects against a *fork* PR. A PR from a
branch **in the repository itself** is not a fork PR, and the exclusion above
does not apply to it. For a solo maintainer whose implementation agent pushes
branches to the same repo, the fork-secret boundary provides no isolation at
all. This is the single most consequential boundary condition in section 1.

## 2. Bot / machine accounts

### Is a second account permitted?

**VERIFIED, with an exact quota.** GitHub's Terms of Service state:

> One person or legal entity may maintain no more than one free Account (if you
> choose to control a machine account as well, that's fine, but it can only be
> used for running a machine).
>
> We do permit machine accounts: A machine account is an Account set up by an
> individual human who accepts the Terms on behalf of the Account, provides a
> valid email address, and is responsible for its actions. A machine account is
> used exclusively for performing automated tasks. Multiple users may direct the
> actions of a machine account, but the owner of the Account is ultimately
> responsible for the machine's actions.
>
> You may maintain no more than one free machine account in addition to your
> free Personal Account.

([GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service))

Note the explicit constraint "used **exclusively** for performing automated
tasks" and the explicit attribution of responsibility back to the human owner.
A machine account is a distinct *credential*, and ToS-sanctioned, but GitHub's
own terms describe it as an extension of the same responsible human.

### Can it hold the verification role on a public repo without an org?

**VERIFIED.** GitHub's machine-user documentation states: "You can add the
machine user as a collaborator on a personal repository (granting read and write
access), as an outside collaborator on an organization repository (granting
read, write, or admin access), or to a team with access to the repositories it
needs to automate." It also records the relevant limitation directly: "**Only
organizations can restrict machine users to read-only access.**"
([Managing deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys))

So on a *personal* repo the machine account's grant is coarse (read or write);
on an *org* repo — the actual configuration here — granular roles are
available.

### How do rulesets reference it for bypass exclusion?

**VERIFIED, and better than the ticket assumed.** `User` is a first-class bypass
actor type. From the `repository-ruleset-bypass-actor` schema:

```json
{
  "actor_id": {
    "type": "integer", "nullable": true,
    "description": "The ID of the actor that can bypass a ruleset. Required for `Integration`, `RepositoryRole`, `Team`, and `User` actor types. If `actor_type` is `OrganizationAdmin`, `actor_id` is ignored. If `actor_type` is `DeployKey`, this should be null. `OrganizationAdmin` is not applicable for personal repositories."
  },
  "actor_type": {
    "enum": ["Integration", "OrganizationAdmin", "RepositoryRole", "Team", "DeployKey", "User"]
  },
  "bypass_mode": {
    "enum": ["always", "pull_request", "exempt"], "default": "always",
    "description": "When the specified actor can bypass the ruleset. `pull_request` means that an actor can only bypass rules on pull requests. [...] When `bypass_mode` is `exempt`, rules will not be run for that actor and a bypass audit entry will not be created."
  }
}
```

([`repository-ruleset-bypass-actor`, api.github.com OpenAPI description](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json);
rendered at [REST: repository rules](https://docs.github.com/en/rest/repos/rules))

Three things to take from this:

- `bypass_actors` is an **allowlist**, not a denylist. There is no "exclude this
  actor" primitive. "Excluding the owner" is expressed as *not listing* the
  owner — which works, and is exactly the mechanism section 4 depends on.
- An individual `User` can be named, and a specific `Integration` (App) can be
  named — so a machine account or App can be given narrow bypass while the human
  gets none.
- `bypass_mode: "exempt"` suppresses the audit entry. For an identity-separation
  design whose evidence story relies on bypass being *visible*, that value is a
  hole worth knowing about.

The documented eligibility list from the organization-ruleset page is:
"Repository admins, organization owners, and enterprise owners; the maintain or
write role, or custom repository roles based on the write role; Teams, excluding
secret teams."
([Creating rulesets for repositories in your organization](https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization))

One fork-specific rule, directly relevant because this repo is a fork: "For a
forked repository, the only people who have bypass permissions for a push rule
are the people who have bypass permissions in the root repository." (same page)
That applies to **push** rulesets specifically.

### Can a second identity supply the missing approval?

**VERIFIED.** "Pull request authors cannot approve their own pull requests."
([Approving a pull request with required reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews))
This is a genuine platform-enforced separation — the one place where "the
producer cannot certify its own work" is enforced by GitHub rather than by
configuration. Its reach is narrow: it binds the *approval* action only, not
merging, not pushing, and not ruleset editing.

### Can a GitHub App be the reviewer?

**VERIFIED — no, and this is a hard constraint on the App route.** Two
independent primary sources agree:

1. The ruleset `required_reviewers` parameter takes a `Reviewer` whose `type`
   enum has exactly one member:

   ```json
   {
     "title": "Reviewer",
     "description": "A required reviewing team",
     "properties": {
       "id": {"type": "integer", "description": "ID of the reviewer which must review changes to matching files."},
       "type": {"type": "string", "description": "The type of the reviewer", "enum": ["Team"]}
     },
     "required": ["id", "type"]
   }
   ```

   ([`repository-rule-params-reviewer`](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json))
   A ruleset required reviewer can only ever be a **Team**. Not a User, not an
   Integration.

2. CODEOWNERS is likewise restricted to humans and teams: "You can use a
   CODEOWNERS file to define **individuals or teams** that are responsible for
   code in a repository," and "The people you choose as code owners **must have
   write permissions** for the repository," and "If you specify a user or team
   that doesn't exist or has insufficient access, a code owner will not be
   assigned."
   ([About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners))
   The documented syntax enumerates users and teams only; there is no App
   notation.

The consequence for identity separation is specific and important: **the
approval-shaped controls cannot be delegated to an App.** An App can *publish a
check* (section 1) and that check can be *pinned* as required (section 4), but
an App cannot occupy the reviewer slot. If the design wants the verification
identity to withhold an **approval**, that identity must be a *user* — i.e. a
machine account, with write access, and (for the ruleset path) in a team. If it
only needs to withhold a **check**, an App suffices and is the stronger option.

## 3. Actions-native separation, without a second identity

### Environments and deployment protection rules

**VERIFIED, including the plan-availability detail that usually bites.**

> Environments, environment secrets, and deployment protection rules are
> available in public repositories for all current GitHub plans. [...] If you
> are on a GitHub Free, GitHub Pro, or GitHub Team plan, other deployment
> protection rules, such as a wait timer or required reviewers, are only
> available for public repositories.
>
> Users with GitHub Free plans can only configure environments for public
> repositories. Organizations with GitHub Team and users with GitHub Pro can
> configure environments for private repositories.

([Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments))

Because this repository is public, required reviewers and wait timers are
available on the current Team plan. Environment secret scoping is documented on
the same page: "workflow jobs that use this environment can only access these
secrets after any configured rules (for example, required reviewers) pass." That
is a real mechanism for R-2.9-style `forbidden_reads`: a job that does not
declare `environment:` cannot read that environment's secrets, and a job that
does declare it is gated behind the protection rules first.

Live confirmation that environments exist here:

```console
$ gh api repos/constructorfleet/SketchForge-3D/environments --jq '.total_count'
2
```

### Self-review

**VERIFIED, and this is where Actions-native separation stops.** The environment
configuration offers an explicit opt-in: "Optionally, to prevent users from
approving workflows runs that they triggered, select **Prevent self-review**."
Also: "Only one of the required reviewers needs to approve the job for it to
proceed." (same page)

Read those two sentences together under the ticket's premise of one human:

- Without `Prevent self-review`, the maintainer approves their own deployment,
  and the gate is theatre.
- With `Prevent self-review` **and only themselves as reviewer**, no run can
  ever be approved — the gate is a deadlock, not a control.

`Prevent self-review` therefore converts to a real control **only** when a
second willing human reviewer exists. In this repository one does
(`ajanis`); under the ticket's stated one-human premise, one does not. This is
a people fact masquerading as a configuration fact, and it should be recorded
as such.

### `GITHUB_TOKEN` permissions

**VERIFIED.** Job- and workflow-level `permissions:` narrow the `GITHUB_TOKEN`
scope, and the repository has a default setting. The live default here is
permissive:

```console
$ gh api repos/constructorfleet/SketchForge-3D/actions/permissions/workflow
{"default_workflow_permissions":"write","can_approve_pull_request_reviews":true}
```

`can_approve_pull_request_reviews: true` is worth flagging plainly: the
repository is currently configured to let Actions approve pull requests. Any
design that treats "an approval exists" as evidence of independent review must
account for that setting, because it is a path to an approval produced by the
same workflow machinery that produced the code.

Note also from section 1 that `GITHUB_TOKEN` **cannot** reach Projects V2 at
all, and is read-only on fork PRs.

### OIDC

**NOT ESTABLISHED, and the docs point the other way.** GitHub's OIDC
documentation frames the feature exclusively as an exchange with an *external*
provider: "OpenID Connect allows your workflows to exchange short-lived tokens
directly from your cloud provider," and "After you have established a trust
connection with a cloud provider that supports OIDC, you can configure your
workflow to request a short-lived access token directly from the cloud
provider." Every worked example is a third party (AWS, Azure, GCP, Vault, JFrog,
PyPI, Docker, Octopus).
([OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect))

I found **no** primary documentation that GitHub's own API accepts a GitHub
Actions OIDC token as an authentication credential. Treat "use OIDC to assume a
different identity against the GitHub API" as unsupported-because-undocumented.
OIDC is a way to reach *outside* GitHub with a workflow-bound identity; it is
not a way to obtain a second identity *within* GitHub.

### Who can change all of this?

**VERIFIED.** Workflow files are repository contents, and modifying them
requires only the `workflows` App permission ("The level of permission to grant
the access token to update GitHub Actions workflow files", write-only in the
schema) or ordinary write access via a PR. Environment protection rules are
repository settings under "Who can use this feature? Repository owners"
(environments page, above). Nothing in the Actions-native toolbox is beyond
unilateral edit by a repository admin.

## 4. Branch rulesets

### Can a required check be pinned to a specific App?

**VERIFIED — yes.** This is the cleanest affirmative finding in the brief. The
`StatusCheckConfiguration` schema used by the `required_status_checks` ruleset
rule is:

```json
{
  "title": "StatusCheckConfiguration",
  "description": "Required status check",
  "type": "object",
  "properties": {
    "context": {
      "type": "string",
      "description": "The status check context name that must be present on the commit."
    },
    "integration_id": {
      "type": "integer",
      "description": "The optional integration ID that this status check must originate from."
    }
  },
  "required": ["context"]
}
```

([`repository-rule-params-status-check-configuration`, api.github.com OpenAPI description](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json))

So a required check can be bound to an originating App by id. A check posted
under the same context name by a *different* App does not satisfy the rule. The
classic branch-protection equivalent is `checks[].app_id` on
`protected-branch-required-status-check` (same description), so the capability
exists in both systems.

This is the mechanism by which "the acceptance check must come from the
verification App" becomes machine-enforced rather than conventional. Note the
field is **optional** and defaults to unset — meaning a ruleset that merely
names a context accepts that context from *any* source.

This repository's `main` ruleset currently does **not** pin any check:

```console
$ gh api repos/constructorfleet/SketchForge-3D/rulesets/25463151 --jq '.rules[] | select(.type=="required_status_checks")'
{"type":"required_status_checks","parameters":{
  "strict_required_status_checks_policy":false,
  "do_not_enforce_on_create":false,
  "required_status_checks":[
    {"context":"Typecheck and unit tests"},
    {"context":"Static export build"},
    {"context":"Conventional commit"}]}}
```

Every entry is a bare `context` with no `integration_id`. The checks that do run
are produced by the `github-actions` App (`app_id` 15368), confirmed on a recent
commit:

```console
$ gh api repos/constructorfleet/SketchForge-3D/commits/3dc11df/check-runs \
    --jq '.check_runs[] | select(.name=="Typecheck and unit tests" or .name=="Static export build" or .name=="Conventional commit") | {name, app: .app.slug, app_id: .app.id}'
{"app":"github-actions","app_id":15368,"name":"Static export build"}
{"app":"github-actions","app_id":15368,"name":"Typecheck and unit tests"}
```

Two observations from that output rather than one. First, the pinning gap: these
contexts would be satisfied by a check of the same name from *any* App, because
no `integration_id` is set. Second, the required context `Conventional commit`
produced **no check run on this commit at all** — it is a `pull_request`-event
check (`.github/workflows/pr-title.yml`), so it is absent from a pushed commit's
check-runs list. A required context that never reports on a given ref is a gate
that can only be cleared by bypass, which is consistent with the admin
`always` bypass recorded below.

### Can bypass exclude the repository owner?

**VERIFIED in the narrow sense, and this is the crux.** Two separate facts have
to be held apart:

1. **Can the owner be left off the bypass list?** Yes. `bypass_actors` is an
   allowlist (section 2); rulesets apply to admins by default unless a matching
   actor is listed. Unlike classic branch protection's "include
   administrators" toggle, there is no implicit admin exemption.

2. **Can the owner be *prevented from putting themselves back on it*?** No, at
   the repository level. GitHub states: "People with admin access to a
   repository, or a custom role with the 'edit repository rules' permission, can
   create, edit, and delete rulesets for a repository," and "You can edit a
   ruleset to change parts of the ruleset, such as the name, **bypass
   permissions**, or rules."
   ([Managing rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/managing-rulesets-for-a-repository))

Fact 1 without fact 2 is a speed bump, not a boundary.

Measured on this repository right now, not even fact 1 holds — the admin role
is explicitly granted `always` bypass, and the API confirms the acting user can
bypass:

```console
$ gh api repos/constructorfleet/SketchForge-3D/rulesets/25463151 \
    --jq '{bypass_actors, current_user_can_bypass}'
{
  "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}],
  "current_user_can_bypass": "always"
}
```

`actor_id: 5` is the admin repository role. `current_user_can_bypass: "always"`
is GitHub's own answer to the question, for the acting token, from the
`repository-ruleset` schema's enum of `always | pull_requests_only | never |
exempt`.

### The org-level escape hatch, and why it closes here

Rulesets layer: "if multiple rulesets target the same branch or tag in a
repository, the rules in each of these rulesets are aggregated. If the same rule
is defined in different ways across the aggregated rulesets, the most
restrictive version of the rule applies."
([About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets))

And organization rulesets are not editable by a mere repository admin:
"Organization owners and users with the 'Manage organization ref update rules
and rulesets' permission can manage rulesets at the organization level."
([Managing rulesets for repositories in your organization](https://docs.github.com/en/organizations/managing-organization-settings/managing-rulesets-for-repositories-in-your-organization))

This is the one architecturally real asymmetry available: an **org-level**
ruleset constrains a repo admin who is not an org owner, and the repo admin
cannot aggregate it away.

It does not help the acting identity here, because `Teagan42` holds
`"role": "admin"` in the organization (section 0) — the same human sits on both
sides of the asymmetry. The hatch is only real when the org-owner role is held
by someone, or something, the implementation identity cannot authenticate as.
(An enterprise-level ruleset would extend the same asymmetry one layer further;
enterprise plans are out of scope here and **NOT ESTABLISHED** for this
account.)

### Force-push

**VERIFIED.** The `non_fast_forward` rule is defined as "Prevent users with push
access from force pushing to refs."
([`repository-rule-non-fast-forward`](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json);
[Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets))
It is active on `main` here, together with `deletion`. But `enforcement` is a
first-class mutable field:

```json
{
  "description": "The enforcement level of the ruleset. `evaluate` allows admins to test rules before enforcing them. Admins can view insights on the Rule Insights page (`evaluate` is only available with GitHub Enterprise).",
  "enum": ["disabled", "active", "evaluate"]
}
```

([`repository-rule-enforcement`](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json))

A repo admin can set that field. So `non_fast_forward` stops a force-push by
anyone who is not a repo admin, and stops a repo admin only until they spend one
API call. Note also that `evaluate` — the dry-run mode — is Enterprise-only per
the schema's own description, so on this Team plan the only states are on and
off.

## 5. The honest ceiling

The decisive question is: with one human who can always re-authenticate as
themselves and force-push, which of INV-1's guarantees are *genuinely
unobtainable* versus merely inconvenient to bypass? Being precise about this
matters more than being encouraging about it.

### The governing asymmetry

Every control surveyed above is configured through a repository setting, a
ruleset, a workflow file, an environment, or an App installation. **All five are
editable by a repository admin**, and in the measured configuration the single
human is repo admin *and* org admin. There is no durable control in GitHub's
model that constrains the identity holding admin over the thing being
controlled. A control is only as strong as the weakest identity that can edit
it, and here that identity is the same one the control is meant to bind.

So the ceiling is not set by which features exist. It is set by role topology.

### Genuinely unobtainable, under the one-human premise

- **Non-repudiable prevention of the producer certifying its own work.** Any
  configuration expressing "this identity may not approve/publish" is editable
  by that identity. Unobtainable as *prevention*.
- **A verification identity the human cannot assume.** An App's private key, a
  machine account's password, and a PAT are all ultimately recoverable by the
  human who controls the owning account and its email. Separation of
  *credentials* is achievable (R-2.1); separation of *control* is not.
- **A meaningful `Prevent self-review` gate.** Mechanically available, but with
  exactly one reviewer it is either self-approval or deadlock. It is not a
  control; it is a restatement of how many people you have.
- **An immutable audit trail.** `bypass_mode: "exempt"` suppresses the bypass
  audit entry by design, and ruleset edits, enforcement flips, and history
  rewrites are all admin-available. Tamper-*evidence* is partly obtainable;
  tamper-*proofing* is not.

### Genuinely obtainable, and platform-enforced

These are real, and they are the ones worth building on. They hold without
depending on the human's restraint:

- **Fork-PR code cannot mint the verification identity's token.** Secrets other
  than `GITHUB_TOKEN` are not passed to fork-triggered runs, and `GITHUB_TOKEN`
  is read-only there. Directly satisfies R-7.2/R-7.3 **for fork PRs** — and only
  on GitHub-hosted runners, and only if `pull_request_target` /`workflow_run`
  with untrusted checkout are avoided.
- **A required check can be pinned to a specific App** via `integration_id`, so
  a forged same-named check from another source does not satisfy the gate.
- **An author cannot approve their own PR.** GitHub-enforced, not configurable.
  But note the shape constraint from section 2: the reviewer slot accepts only
  a Team (rulesets) or a user/team (CODEOWNERS), never an App — so this
  guarantee is only reachable by a *second account*, not by an App.
- **Environment secrets are unreachable from jobs that do not declare the
  environment**, and are gated behind protection rules for jobs that do.
  Workable basis for R-2.9.
- **`GITHUB_TOKEN` cannot reach Projects V2 at all**, so Projects-mediated state
  is structurally outside the default workflow identity.

### Obtainable only by changing the premise

The one way to convert "unobtainable" into "obtainable" is not a feature — it is
a second party:

- An **org-level ruleset** whose org-owner role the implementation identity
  cannot authenticate as. Verified asymmetry; currently vacuous here because the
  same human is org admin.
- A **second willing human reviewer**, which makes `Prevent self-review`,
  required approvals, and the no-self-approval rule compose into real
  separation. This repository has a second admin; the ticket's premise does not.

### Bottom line

For a single human with admin over the repository, "the producer cannot certify
its own work" is achievable as **reliable, auditable friction with
platform-enforced guarantees against *untrusted third-party code***, and is
**not** achievable as a guarantee against the maintainer themselves. The second
property requires a role the maintainer does not hold, which under the stated
premise means another party. Any downstream design that treats self-restraint as
enforcement should say so out loud rather than claim a boundary that the API
calls recorded above show is one request wide.

## Appendix: verification method

- Documentation claims were extracted from `docs.github.com` pages and from
  GitHub's published OpenAPI description (`github/rest-api-description`,
  `descriptions/api.github.com/api.github.com.json`, `main` as of 2026-10-21),
  which is the normative source the REST reference renders.
- Repository claims were tested with read-only `gh api` calls against
  `constructorfleet/SketchForge-3D` on 2026-10-21; outputs above are verbatim.
- No writes were made to repository settings, rulesets, or environments in the
  course of this research.
- Facts that could not be grounded in a primary source are marked
  **NOT ESTABLISHED** and are not relied on by section 5. Specifically
  unestablished: GitHub's own API accepting Actions OIDC tokens as a credential
  (the docs scope OIDC exclusively to external providers, so this is
  unsupported-because-undocumented rather than documented-as-impossible); App
  access to *user*-owned Projects V2; enterprise-level ruleset availability for
  this account.
