# Multi-repo workspaces and agent topology for polyrepo feature work (state: November 2026)

Scope: where each agent runs, what it sees, how an agent tree maps onto repositories. Contract testing, release
ordering and integration verification are only touched where they affect topology.

Reading notes for the report writer:

- Research date 2026-11-23. Items older than about 12 months are marked "(older)".
- "Fetched" means the page was read. "Search snippet only" means the claim comes from a search result summary and the
  page itself was not read; treat those as leads, not as verified facts.
- Most practitioner material is self-reported by one team or one author, and several sources are vendors describing
  their own product. There is no controlled comparison of topologies apart from the WideSWE benchmark.

## 1. Topologies for mapping agents onto repos

### Takeaway

Four topologies are documented, and the practitioner write-ups converge on a hybrid: an orchestrator that sits in an
umbrella "workspace" directory above the repo checkouts and holds the plan, with one writing agent per repo, each in
its own worktree. A single agent with every repo mounted is the simplest and is what the only benchmark found
favours for correctness on small sets, but practitioners report context dilution and rule bleed once the set grows.

### Cited Findings

Topology A: orchestrator above the repos plus one agent per repo

- "give each repository its own specialised agent, and let one orchestrator route the work and merge the answers."
  The orchestrator is the main session; workers are Claude Code subagents defined in `.claude/agents/`, one per repo,
  routed by their `description` plus a triage guide in the top-level `CLAUDE.md`. Reported problems of the
  single-agent alternative: context dilution, rules bleeding between repos, serial investigation, guardrails that
  depend on the model remembering. Reported costs of the per-repo design: no shared memory between workers
  ("Workers don't share memory", so the orchestrator must carry anything that crosses repos) and heuristic routing.
  No benchmarks or cost figures. Post dated "Jun 16" without a year, presumably 2026
  — [DEV, One Agent Per Repo](https://dev.to/just_an_electron/one-agent-per-repo-an-orchestration-pattern-for-multi-repo-ai-coding-49ba)
- Solo founder with 15+ repos (Go, Rust, TypeScript, Python, C++): a persistent "manager plane" holds features, task
  status and recent shipments, and an ephemeral "worker plane" of Claude Code sessions plans, implements and reviews.
  "The manager never touches code. The worker never worries about the big picture." and "The write should always be
  focused on a single repo, a single PR." Each worker gets its own git worktree, sandbox and tmux session. Calls
  single-session orchestration "the trap most people fall into" because the context fills and the agent loses track
  of which repo it is in. Posted Mar 27 (2026)
  — [DEV, How I Manage 15+ Repos with Claude Code](https://dev.to/neil_agentic/how-i-manage-15-repos-with-claude-code-without-losing-my-mind-2ood)
- Nx Polygraph (launched 2026; blog post dated 2026-09-01) is a hosted "meta-harness": it indexes the repos a user
  can access, builds "a graph of how they relate via packages and APIs", lets agents pull in relevant repos,
  coordinate changes and open a PR in each. Sessions (repos, branches, PRs, logs) can be handed to another agent.
  Listed integrations: Codex, Claude Code, GitHub, OpenCode. "Free during early access."
  — [Nx blog, Introducing Polygraph](https://nx.dev/blog/nx-cloud-introducing-polygraph)
- Polygraph's agent skill describes the flow as MCP calls: initialise a session, delegate work to child agents in
  each repo, push branches (`cloud_polygraph_init`, `cloud_polygraph_delegate`, `cloud_polygraph_push_branch`). Nx
  describes the result as an "eventually consistent" monorepo because the PRs still merge separately (search snippet
  only; the Nx docs page returned 404 when fetched)
  — [skills.sh, nx polygraph skill](https://skills.sh/nrwl/nx-ai-agents-config/polygraph), [Nx docs, synthetic monorepos](https://nx.dev/docs/concepts/synthetic-monorepos)

Topology B: one agent, all repos mounted in one workspace

- Claude Code documents this directly: `--add-dir` or `permissions.additionalDirectories` gives a session read and
  edit access to "a separately checked-out repository". For changes spanning packages the docs recommend to "Give
  Claude the whole change in one session: handing over the shared edit and its call sites together keeps the
  decisions behind each edit consistent, rather than re-deriving them per package", and to plan first because the
  plan file is re-injected after each compaction
  — [Claude Code docs, large codebases](https://code.claude.com/docs/en/large-codebases)
- WideSWE (arXiv, submitted 2026-09-27): 120 real cross-repository tasks (60 bug fixes, 60 features) from 103
  software ecosystems. "Across seven agent configurations, full task success ranges from 10.83% to 42.50%". The
  paper compares independent execution (one repo at a time) with joint execution under identical prompts: "Joint
  execution can use information from related repositories to guide implementation and verification." Observed
  failures: not identifying necessary changes, recognising them but leaving them unfinished, and modifying the
  required repos without fully satisfying the request
  — [arXiv 2609.33382](https://arxiv.org/abs/2609.33382)
- Limits reported for `--add-dir` style mounting: repos sit at scattered absolute paths, so compilers, bundlers and
  language servers cannot resolve cross-repo modules ("The agent can see the repos. It can't work with them as one
  thing."); exploration of added directories is paid for out of the main session's context; "You must already know
  which repos matter."
  — [DEV, Agent works one repo at a time](https://dev.to/firespark/agent-works-one-repo-at-a-time-work-doesnt-3588), [DEV, How I Manage 15+ Repos](https://dev.to/neil_agentic/how-i-manage-15-repos-with-claude-code-without-losing-my-mind-2ood), [Unblocked, Context Engineering Across Hundreds of Repos](https://getunblocked.com/blog/context-engineering-across-hundreds-of-repos/)
- Starting an agent at a root directory holding about 36 repos meant waiting while it crawled all of them
  — [DEV, Agent works one repo at a time](https://dev.to/firespark/agent-works-one-repo-at-a-time-work-doesnt-3588)

Topology C: meta-repo / umbrella workspace with a manifest

- Superblocks (2026-03-10): a `workspace` repo "with no application code" holding `AGENTS.md`,
  `agents/cross-repo.md`, `docs/`, a `repos.yaml` manifest (repo URLs, paths, default branches), shared infra
  compose files, per-team `profiles/`, and gitignored `repos/` (default checkouts) and `worktrees/` (per-branch
  trees). `just worktree create ENG-123 feature-x` runs `git worktree add` in each selected repo. Rule: do not
  centralise build logic in the workspace; keep it in each repo. Adopted because a monorepo migration was judged too
  costly; the approach is additive, so engineers who skip it are unaffected
  — [Superblocks, A Single Dev Workspace for AI Agents, Part 1](https://superblocks.com/blog/a-single-dev-workspace-for-ai-agents)
- "Agents meta-repo pattern" (2026-03-05, six repos, GitLab, Claude Code): "a dedicated repo that serves as an AI
  agent's knowledge base, orientation guide, and working memory", "Not code — context." Layout: `AGENTS.md`,
  `repos.yaml`, `structure/dependency-graph.md`, `structure/repo-purposes.md`, `conventions/`, `workflows/`
  (including `cross-repo-changes.md`), `scripts/`, `active-work/`, `archive/`. Pitched as "monorepo-like ergonomics
  for your AI agents without restructuring your entire codebase". The author notes a sequel from October 2026 that
  is "a better starting point" (not read)
  — [Agents meta-repo pattern](http://blog.rubbad.uk/2026/03/05/blog-agents-meta-repo-pattern.html)
- mabl (2026-04-08, 25 engineers, 100+ repos): a "Cross Repo Base", "a pseudo mono-repo that sits above all our
  individual repos", holding engineering guides, skills and a "Repo Coordination Graph"; each repo keeps its own
  `CLAUDE.md`; git worktrees for parallel execution; MCP servers configured at workspace level in `.mcp.json`
  — [mabl, AI agents across 75+ repos, Part 1](https://www.mabl.com/blog/how-we-built-a-system-for-ai-agents-to-ship-real-code-across-75-repos)
- Git submodules as the umbrella mechanism get poor reviews for agent work: they "couple repos at the git level and
  track specific commits", and they "don't compose well with worktrees" and give no cross-repo planning or parallel
  execution. One author still recommends them when repos are tightly coupled
  — [DEV, The Missing Workspace Layer](https://dev.to/dean0x/the-missing-workspace-layer-for-agentic-polyrepo-development-pae), [DEV, How I Manage 15+ Repos](https://dev.to/neil_agentic/how-i-manage-15-repos-with-claude-code-without-losing-my-mind-2ood)
- Tooling for this topology, all small and young: Mars (`mars.yaml`, tags, `mars branch feature-auth --tag backend`;
  bash, no Windows), Orbit (shared `.repos/` pool plus per-task directories of worktrees), Garth (branch, worktree
  and Docker-sandboxed agent per task; 5 GitHub stars when read), and, from search snippets only, gitgrip (YAML
  manifest with per-repo build/test/lint metadata for agents), Canopy (multi-repo worktree manager exposed as MCP
  tools), Grove (`grove.toml`), mit, agentspace and Project Loom. Older generic tools named as predecessors: `meta`
  (Node, `meta.json`), gita, myrepos
  — [DEV, The Missing Workspace Layer](https://dev.to/dean0x/the-missing-workspace-layer-for-agentic-polyrepo-development-pae), [DEV, Agent works one repo at a time](https://dev.to/firespark/agent-works-one-repo-at-a-time-work-doesnt-3588), [Garth](https://github.com/ealt/garth), [gitgrip manifest docs](https://docs.rs/crate/gitgrip/1.0.0/source/docs/MANIFEST.md), [Canopy](https://github.com/ashmitb95/canopy), [Grove](https://github.com/jossmoff/grove), [mit](https://github.com/opentreehq/mit), [agentspace](https://github.com/irucsS-9/agentspace), [Project Loom](https://pypi.org/project/project-loom/)

Topology D: per-repo agents talking over a shared channel

- Claude Code agent teams: a lead session plus teammates that are full independent sessions, a shared task list with
  dependencies and file-locked claiming, and a mailbox (`~/.claude/teams/{team-name}/inboxes/{agent-name}.json`).
  Listed use case: "Cross-layer coordination: changes that span frontend, backend, and tests, each owned by a
  different teammate". Experimental and off by default; "use significantly more tokens than a single session"; for
  "sequential tasks, same-file edits, or work with many dependencies, a single session or subagents are more
  effective"
  — [Claude Code docs, agent teams](https://code.claude.com/docs/en/agent-teams)
- The ttal setup uses a daemon for messages (`ttal send` agent to agent, `ttal alert` worker to manager, workers
  notify their spawner automatically), with CI status, PR reviews and task updates routed through the same daemon
  — [DEV, How I Manage 15+ Repos](https://dev.to/neil_agentic/how-i-manage-15-repos-with-claude-code-without-losing-my-mind-2ood)
- A comment on the per-repo pattern names the hard part of any message-passing design: "making their summaries and
  handoffs precise enough that cross-repo changes do not drift", "Otherwise the shared context becomes a blender of
  half-remembered constraints."
  — [DEV, One Agent Per Repo (comments)](https://dev.to/just_an_electron/one-agent-per-repo-an-orchestration-pattern-for-multi-repo-ai-coding-49ba)

Framing

- Multi-agent and multi-repo orchestration are different problems that "often overlap, but solving one does not
  automatically solve the other." (2026-09-23)
  — [Telerik, Multi-Agent Orchestration for Software Delivery](https://www.telerik.com/blogs/multi-agent-orchestration-software-delivery-patterns-multi-repository-workflows)

### Inferences

- The sources disagree on one point and it matters for design. Anthropic's docs and WideSWE both say joint visibility
  improves consistency; practitioners say a single session over many repos degrades. These are compatible if reading
  and writing are separated: the planning step needs joint visibility of the affected repos (at least their
  interfaces), while each writing agent should be confined to one repo.
- Topology C is less an alternative to A than its substrate: every team that reports running A at scale also built an
  umbrella directory or meta-repo to put the orchestrator in.
- For a parent-child session tree, A maps naturally: the feature orchestrator's cwd is the umbrella directory, each
  repo child's cwd is that repo's worktree.

### Gaps

- No source measures A against B on the same tasks with the same model apart from WideSWE's independent-versus-joint
  comparison, and I read only its abstract page; per-configuration numbers and the size of the joint-execution
  advantage were not retrieved.
- No independent evaluation of Polygraph or of any of the small workspace tools was found.

## 2. Orchestrator working directory and location of feature-level artifacts

### Takeaway

The documented practice is to run the orchestrator in a dedicated non-code workspace or meta-repo above the repo
checkouts and keep feature state there as files (one file plus one folder per epic), with the issue tracker as the
cross-repo link for humans. Nobody reports duplicating the feature spec into each repo; per-repo material is kept to
conventions and a pointer back.

### Cited Findings

- Meta-repo pattern: the agent is launched in "our top-level workspace" with a ticket number and product name; a
  root `AGENTS.md` routes to the right product-line meta-repo. Each epic has `active-work/EPIC-NNN.md` (overview,
  repositories involved, dated progress log, next steps, decisions with rationale) and a folder
  `active-work/EPIC-NNN/` with `analysis.md`, `recommendations.md`, `plan.md`, `ticket-summary.md`. Auto-memory holds
  only a pointer ("Active epic: EPIC-001, see `active-work/EPIC-001.md`"). Completed epics move to `archive/`.
  Reported effect: "The fifth session had the same quality of context as the first."
  — [Agents meta-repo pattern](http://blog.rubbad.uk/2026/03/05/blog-agents-meta-repo-pattern.html)
- Same source: conventions are stored once ("The meta-repo is the single source of truth") and per-repo `AGENTS.md`
  files "reference the meta-repo for conventions and workflows" instead of repeating them
  — [Agents meta-repo pattern](http://blog.rubbad.uk/2026/03/05/blog-agents-meta-repo-pattern.html)
- Telerik: "if context only exists in an agent's session, it disappears when the session ends"; plans, decisions and
  run history belong in a durable store such as a dedicated Git branch. The coordinator writes the plan including
  which files each task may touch, and the plan should record which repo's delivery gate enforces each requirement.
  Handoffs should be "a versioned artifact that can be reviewed like the code it ships with" with four fields:
  scope, interface requirement, base commit, evidence
  — [Telerik, Multi-Agent Orchestration for Software Delivery](https://www.telerik.com/blogs/multi-agent-orchestration-software-delivery-patterns-multi-repository-workflows)
- Superblocks: the workspace repo's `docs/` holds data flows, protocols and architectural invariants; the tracker is
  the feature link ("Name branches after tickets (`ENG-123`)"; Linear or Jira links the PRs from several repos to
  one ticket and does not auto-close until all merge). The article does not say where feature plans live
  — [Superblocks, A Single Dev Workspace for AI Agents, Part 1](https://superblocks.com/blog/a-single-dev-workspace-for-ai-agents)
- ttal: the manager agents hold the cross-repo plan; brainstorming "forks into per-repo plan sessions that inherit
  the full conversation"; tasks live in Taskwarrior, knowledge in a notes tool. No plan file location is given
  — [DEV, How I Manage 15+ Repos](https://dev.to/neil_agentic/how-i-manage-15-repos-with-claude-code-without-losing-my-mind-2ood)
- Orbit: the shared pool has a `docs/` directory for "design notes, decisions, ADRs"
  — [DEV, Agent works one repo at a time](https://dev.to/firespark/agent-works-one-repo-at-a-time-work-doesnt-3588)
- Polygraph keeps the feature-level record server-side as a session: a past session can be referenced and returns
  its description, PRs and traces
  — [Nx blog, Introducing Polygraph](https://nx.dev/blog/nx-cloud-introducing-polygraph)
- Claude Code mechanics that make an umbrella cwd workable: CLAUDE.md files are loaded "from your working directory
  and every parent directory at launch", so an umbrella-level file reaches a session started inside a child repo;
  project settings in `.claude/settings.json` are not inherited from parent directories. A plan written in plan mode
  is re-injected after compaction
  — [Claude Code docs, large codebases](https://code.claude.com/docs/en/large-codebases)

### Inferences

- A reasonable artifact split that matches the sources: feature workspace holds requirements, spec, cross-repo plan,
  decision log and status ledger; each repo receives only its own slice of the plan, written as a handoff with the
  Telerik fields (scope, interface requirement, base commit, evidence) and an identifier of the feature and spec
  section it derives from.
- Traceability in practice is carried by a shared key (ticket or epic ID) in the branch name, the PR body and the
  ledger, not by links between files in different repos.
- Whether a per-repo plan should be committed into the target repo is not addressed by any source. Keeping it in the
  feature workspace avoids leaving feature-specific planning files in service repos, at the price that a repo
  reviewer must follow a link to see why the change exists.

### Gaps

- No source describes a schema for a cross-repo status ledger, or how a per-repo plan is re-validated when the
  feature spec changes mid-flight.
- mabl's Part 2 (the four-phase pipeline from Jira ticket to merged PR) was announced but not read; it may contain
  the plan and spec locations that Part 1 omits.

## 3. Multi-repo support in current tools and stated limits

### Takeaway

Local CLI agents (Claude Code, Copilot CLI, Codex CLI, Amp) can all mount several directories into one session, and
the cloud agents moved during 2026 from strictly one repo per task towards multi-repo environments (Cursor, Codex,
Claude Code on the web). The unit of delivery is unchanged everywhere: one branch and one PR per repo, with no native
"these PRs are one feature" object.

### Cited Findings

Claude Code

- `--add-dir` / `/add-dir` and `permissions.additionalDirectories` both grant read and edit access. They differ in
  what else loads: `additionalDirectories` never loads the added directory's CLAUDE.md, rules or skills; `--add-dir`
  loads skills, and loads CLAUDE.md and `.claude/rules/` only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`
  — [Claude Code docs, large codebases](https://code.claude.com/docs/en/large-codebases)
- Subagents: "A subagent starts in the main conversation's current working directory", and `cd` does not persist
  between its tool calls. `isolation: worktree` gives "an isolated copy of the repository branched by default from
  your default branch". Nesting: "a subagent can spawn subagents of its own, up to three layers below the main
  conversation", configurable with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`. Default cap of 20 concurrent subagents.
  Tools can be restricted per subagent with `tools` / `disallowedTools`. Subagents load the CLAUDE.md hierarchy of
  the main conversation but none of its history
  — [Claude Code docs, subagents](https://code.claude.com/docs/en/sub-agents)
- This contradicts the DEV post's statement "Subagents cannot spawn other subagents", which reflects earlier
  behaviour
  — [Claude Code docs, subagents](https://code.claude.com/docs/en/sub-agents); contradicted by [DEV, One Agent Per Repo](https://dev.to/just_an_electron/one-agent-per-repo-an-orchestration-pattern-for-multi-repo-ai-coding-49ba)
- Worktrees are created under `.claude/worktrees/<name>/` of the repository on branch `worktree-<name>`, from the
  remote default branch unless `worktree.baseRef` is `"head"`; the base cannot be set to a named branch.
  `--worktree` requires a git repository ("Can only use --worktree in a git repository") unless a `WorktreeCreate`
  hook replaces the creation logic. The isolation checks "apply to the repository you launched Claude Code from". A
  subagent in a worktree takes its instruction files from the main conversation, not from its worktree
  — [Claude Code docs, worktrees](https://code.claude.com/docs/en/worktrees)
- Agent teams: experimental; one team per session; "No nested teams: teammates cannot spawn their own teammates";
  the lead is fixed; no per-teammate permission mode at spawn; in-process teammates are not restored by `/resume`;
  teammates are not spawned in non-interactive (`-p`) or Agent SDK sessions. Suggested size 3-5 teammates
  — [Claude Code docs, agent teams](https://code.claude.com/docs/en/agent-teams)
- Claude Code on the web: "you can add multiple repositories to a single session". In a two-repo test, issues and
  draft PRs were created independently per repo: "There was no behavior where changes across multiple repositories
  were consolidated into a single PR." One author's environment, 2026-09-30
  — [Classmethod, Managing Multiple Repositories from Claude Code on the Web](https://dev.classmethod.jp/en/articles/claude-code-web-multi-repo-issues-prs/)

GitHub Copilot

- Current docs: "When Copilot runs on GitHub Actions, Copilot can only make changes in the repository specified when
  you start a task." and "Copilot can only work on one branch at a time and can open one pull request per task."
  The GitHub MCP server "only provides access by default to context in the repository where the agent is working";
  broader access needs repository MCP settings. Sessions on GitHub Actions have "a maximum execution time of 59
  minutes". The same page, as summarised by the fetch tool, says cloud sandbox sessions can span multiple
  repositories; I could not get that sentence verbatim, so verify before relying on it
  — [GitHub Docs, about the coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
- An earlier or alternate version of the docs states flatly that Copilot "cannot make changes across multiple
  repositories in one run" (search snippet only)
  — [GitHub Docs, coding agent overview](https://docs.github.com/copilot/concepts/coding-agent/about-copilot-coding-agent)
- Community thread (opened 2026-03-26, no GitHub staff reply, roadmap question unanswered): "Copilot Coding Agents
  are sandboxed to a single repository, so they don't natively handle cross-repo changes." The asker notes that
  multi-root VS Code workspaces solve it locally but the problem is cloud agents triggered from Jira; cloning
  siblings in `copilot-setup-steps` was considered and judged messy
  — [GitHub Community discussion 190627](https://github.com/orgs/community/discussions/190627)
- Copilot CLI accepts `--add-dir` repeatedly and has `/add-dir`; a May 2026 post confirms using it once per project
  and says this does not carry over to the cloud agent or desktop app (search snippet only)
  — [GitHub Docs, Copilot CLI command reference](https://docs.github.com/en/copilot/reference/cli-command-reference), [charlie.fish, multiple projects in GitHub Copilot](https://charlie.fish/posts/2026/05/how-to-work-with-multiple-projects-in-github-copilot)
- GitHub Copilot app Projects (public preview): "Projects can span one or more repositories or focus on tasks that
  don't require a repository."; "To tackle a task in a specific repository, you can start a session directly from
  that repository." The page does not say whether one session can edit several repos
  — [GitHub Docs, working with projects](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-projects)
- Copilot Spaces went GA on 2026-06-02; repositories can be attached to a Space (changelog 2025-08-13, older) and
  are searched rather than loaded whole. Copilot in Slack and Teams gained multi-repo conversations on 2026-10-15
  (all search snippets only)
  — [GitHub changelog, Spaces GA](https://github.blog/changelog/2026-06-02-copilot-spaces-is-now-generally-available/), [GitHub changelog, add repositories to Spaces](https://github.blog/changelog/2025-08-13-add-repositories-to-spaces), [GitHub changelog, Slack and Teams multi-repo](https://github.blog/changelog/2026-10-15-copilot-in-slack-and-teams-adds-model-and-repository-updates)

OpenAI Codex

- A cloud environment is set up by selecting "the repositories to check out" (plural); "Adding a repository to a
  running task is separate from this automatic project setup." and "You can ask Codex to clone a repository the
  environment can access". Automatic project setup "doesn't include GitLab repositories". The page does not describe
  the checkout layout or whether one task opens PRs in several repos
  — [OpenAI, Codex cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)
- Multi-repo environments were an open community request in 2025 (older; search snippet only)
  — [OpenAI community, connect multiple repos to one environment](https://community.openai.com/t/codex-connect-multiple-repos-to-one-environment/1272748)
- Secondary sources: Codex CLI takes `--add-dir` for write access across repos and its subagents "operate on
  isolated worktrees"; combined AGENTS.md files stop at 32 KiB by default
  — [Codex Knowledge Base, micro-frontend guide](https://codex.danielvaughan.com/2026/05/31/codex-cli-micro-frontend-development-module-federation-2-nx-independent-deployments/), [Unblocked, Context Engineering Across Hundreds of Repos](https://getunblocked.com/blog/context-engineering-across-hundreds-of-repos/)

Cursor

- Docs: "Cloud agents can also run in multi-repo environments. Use one when a task spans separate frontend, backend,
  infrastructure, or shared-library repositories." and "The agent can inspect the full workspace, make coordinated
  changes, and open pull requests in the repos it changes." Requires "read-write privileges to your repo and any
  dependent repos or submodules."
  — [Cursor docs, cloud agents](https://cursor.com/docs/cloud-agent)
- Shipped 2026-05-13 for cloud agents and automations, building on multi-root workspaces in the agents window
  (2026-04-24). Forum reports of setup failures (including GitLab) and of Linear-triggered agents not getting the
  multi-repo environment (search snippets only)
  — [Cursor changelog 2026-05-13](https://cursor.com/changelog/05-13-26), [Cursor forum, multi-repo environment setup](https://forum.cursor.com/t/cant-setup-a-multi-repo-cloud-agent-environment/160755), [Cursor forum, Linear trigger](https://forum.cursor.com/t/use-multirepo-workspace-when-triggered-from-linear/163446)
- Conflicting statement, November 2026: "Cursor's Cloud Agents don't support multi-root workspaces, and worktrees
  are disabled in them." This may distinguish multi-root workspaces from multi-repo environments, or may be stale
  — [Unblocked, Context Engineering Across Hundreds of Repos](https://getunblocked.com/blog/context-engineering-across-hundreds-of-repos/); contradicted by [Cursor changelog 2026-05-13](https://cursor.com/changelog/05-13-26)

Devin, Amp, others

- Devin: all configured repositories co-exist on the same machine state at the start of each session; parallel work
  is done by launching several sessions, each on its own machine; MultiDevin's manager merges worker results "into
  one branch or pull request"; stacked PRs are single-repo and GitHub.com only (search snippets only; some of this
  is from 2024 release notes, older)
  — [Devin docs, release notes 2024](https://docs.devin.ai/release-notes/2024), [Devin docs, MultiDevin](https://docs.devin.ai/working-with-teams/multidevin), [Devin docs, stacked PRs](https://docs.devin.ai/work-with-devin/stacked-prs)
- Amp: multi-root workspace support since 2025-06-02 (older): "Reading, editing, and reverting file changes now
  works consistently across different workspace roots" and "The search agent now covers all workspace roots". A
  changelog aggregator reports that in 2026 Amp runners can work across multiple projects and create worktrees from
  the composer; third-party posts describe a Librarian sub-agent for cross-repo code search (aggregator and
  third-party claims, not verified against Amp's own changelog)
  — [Amp news, multi-root workspaces](https://ampcode.com/news/multi-root-workspaces), [Amp changelog aggregator](https://www.gradually.ai/en/changelogs/ampcode/), [Codex Knowledge Base, Amp analysis](https://codex.danielvaughan.com/2026/04/07/sourcegraph-amp-multi-repo-orchestrator/)
- Sourcegraph's own comparison page places Claude Code, Codex and Gemini CLI in "single local repository scope" and
  positions Sourcegraph as the cross-repository search layer (vendor claim; search snippet only)
  — [Sourcegraph, context compare](https://sourcegraph.com/resources/context-compare)

Cross-cutting limit

- "GitHub has no concept of "these three PRs are one feature.""
  — [Superblocks, A Single Dev Workspace for AI Agents, Part 1](https://superblocks.com/blog/a-single-dev-workspace-for-ai-agents)

### Inferences

- In Claude Code, `isolation: worktree` and `--worktree` are per-repository mechanisms tied to the repo the session
  was launched from. An orchestrator whose cwd is a non-git umbrella directory cannot use them as they are; it needs
  either a `WorktreeCreate` hook that builds a per-feature set of worktrees, or child sessions started with their
  cwd already inside a per-repo worktree created by plain `git worktree add`.
- A subagent inherits the parent's cwd, so "one subagent per repo" under a single Claude Code session relies on
  prompts and tool restrictions, not on cwd, to keep it in its repo. Separate sessions with their own cwd (as in a
  desktop app that spawns child sessions) give a harder boundary than subagents do.
- Because every tool caps delivery at one PR per repo, a cross-repo feature always ends as N PRs, and linking them is
  the orchestrator's job.

### Gaps

- Augment, Factory (Droid) and JetBrains Junie: no primary-source statement on multi-repo sessions was found.
  Augment's material is tutorial-level; Factory search returned only version numbers; Junie returned nothing
  relevant.
- Copilot custom agents (`.github/agents`) and whether they can reach across repos: not confirmed either way.
- Whether Claude Code agent-team teammates can be given different working directories is not stated in the docs.
- Codex cloud: layout of multiple repos in the container and PR behaviour across repos are not documented on the
  page read.

## 4. Giving a per-repo agent enough context without the whole feature

### Takeaway

The working recipe is layered: a short repo-local instruction file, an umbrella-level routing and invariants file, a
machine-readable manifest plus dependency graph, and search or a catalog for everything else. Long descriptive
overviews are reported to hurt; the high-value content is commands, non-obvious rules, and who consumes what.

### Cited Findings

- A five-rung ladder for platform teams (2026-11-06; the top rung is the publisher's product): (1) shared rules
  baseline synced into every repo's AGENTS.md / CLAUDE.md by a bot, (2) multi-root sessions, (3) org-wide code
  search via the GitHub MCP server, (4) service catalog and ownership map (Backstage, CODEOWNERS), (5) a central
  context layer over MCP. Move up "when the same miss repeats". Limits named: code search covers the default branch
  only with a 100-result cap; a catalog is "as current as their last YAML edit" and records who and what, rarely
  why
  — [Unblocked, Context Engineering Across Hundreds of Repos](https://getunblocked.com/blog/context-engineering-across-hundreds-of-repos/)
- Same source on per-repo files: under about 100 lines, covering build commands, banned patterns, shared clients to
  use, and local quirks; leave out repository tours. It cites a February 2026 AGENTS.md study finding that overviews
  did not help and that context files raised inference cost by over 20%, and an August 2026 finding that when a
  stale convention file conflicts with the code, "agents follow the file" (both cited second-hand; originals not
  read)
  — [Unblocked, Context Engineering Across Hundreds of Repos](https://getunblocked.com/blog/context-engineering-across-hundreds-of-repos/)
- mabl's per-repo `CLAUDE.md`: purpose, architecture, dependencies, development conventions (for example commit
  flags `[skip ci]`, `[bump:patch]`) and step-by-step workflows. Its central Repo Coordination Graph: 850+ lines
  over 79 repos with dependency graphs, Pub/Sub topic maps, database table ownership and prescribed release
  ordering; agents query it for which repos need updates, merge order and reviewers. Context drift fell "from ~40%
  of our failures to <5%" after the cross-repo base was added (self-reported)
  — [mabl, AI agents across 75+ repos, Part 1](https://www.mabl.com/blog/how-we-built-a-system-for-ai-agents-to-ship-real-code-across-75-repos)
- Meta-repo `repos.yaml` fields per repo: path, languages, build system, build and test commands, version files, CI
  project, submodules. Agents read `version_files` directly instead of parsing prose. The first iteration had "too
  much documentation", which wasted tokens
  — [Agents meta-repo pattern](http://blog.rubbad.uk/2026/03/05/blog-agents-meta-repo-pattern.html)
- Orbit gives each repo a short "memo" card saying when to add the repo and where to start reading; the agent reads
  the cards to decide which repos to pull in instead of crawling all 36. Staleness tracking exists but the refresh
  is advisory
  — [DEV, Agent works one repo at a time](https://dev.to/firespark/agent-works-one-repo-at-a-time-work-doesnt-3588)
- Superblocks: each worktree's `AGENTS.md` is a symlink to `agents/cross-repo.md`, a routing index plus
  architectural invariants linking to canonical docs; per-repo rules are loaded lazily; the workspace `AGENTS.md`
  gives tooling context (task commands, active profile, port registry); `CODEOWNERS` enforces review of
  `cross-repo.md` to prevent drift
  — [Superblocks, A Single Dev Workspace for AI Agents, Part 1](https://superblocks.com/blog/a-single-dev-workspace-for-ai-agents)
- Meta (2026-04-06) generated a cross-repo dependency index with 50+ specialised agents, reported to cut a "what
  depends on X?" lookup from roughly 6,000 tokens to roughly 200 (as relayed by a vendor-affiliated post; Meta's
  post not read)
  — [DEV, AI coding agents need cross-repo context](https://dev.to/danielwe/ai-coding-agents-need-cross-repo-context-the-teams-running-them-at-scale-are-already-building-it-ek0)
- Red Hat Developer Hub connects Claude Code to the Backstage catalog and TechDocs through CLI or MCP (search
  snippet only)
  — [Red Hat Developer, Developer Hub and AI coding agents](https://developers.redhat.com/articles/2026/09/15/red-hat-developer-hub-preventing-compliance-violations-ai-coding-agents)
- Claude Code large-codebase guidance moves conventions out of always-loaded files into skills, plugins and MCP code
  search once per-directory files stop scaling
  — [Claude Code docs, large codebases](https://code.claude.com/docs/en/large-codebases)

### Inferences

- A repo card assembled from what these sources found useful: name and one-line purpose; when to involve this repo
  and where to start reading; tech stack and build/test/lint commands; what it exposes (APIs, events, exposed
  modules, published packages) and what it consumes; owners and reviewers; default branch and version files;
  branch, commit and release conventions; position in the dependency and release order; date and commit at which
  the card was generated. Everything except purpose and "when to involve" can be generated, which addresses the
  staleness complaint.
- The orchestrator should read cards and the dependency graph; a repo agent should get its repo's own instruction
  file plus the interface slice of its neighbours, not their cards in full.

### Gaps

- No source publishes a repo-card template with measured effect; the list above is a synthesis.
- The two studies cited by Unblocked (AGENTS.md overview study, "coherence debt") were not located or read.

## 5. Isolation when several agents write at once, and linking branches and PRs

### Takeaway

One worktree per agent per repo, all on a branch named after the feature ticket, is the standard. Enforcement needs
to be structural (tool removal, hooks, OS or container sandbox) because prompt-level boundaries are reported to fail.
PR linking is done by convention: ticket key in the branch name and a second pass that writes sibling PR URLs into
each PR body.

### Cited Findings

- Worktrees give "each agent its own working directory, index and HEAD"; start every worktree from a fresh
  `origin/main`; let only one agent edit a hotspot file (lockfiles, DI registries) at a time; "Only OS permissions
  or sandboxing draw a line an agent instruction cannot cross."
  — [Telerik, Multi-Agent Orchestration for Software Delivery](https://www.telerik.com/blogs/multi-agent-orchestration-software-delivery-patterns-multi-repository-workflows)
- Per-feature workspace of worktrees: `just worktree create ENG-123 feature-x` adds a worktree in each selected repo
  under `worktrees/`; "Git shares the object store; only the working tree is separate." Orbit does the same with a
  shared `.repos/` pool and per-task directories, which also makes the worktrees real sibling directories so go
  workspaces, Cargo and pnpm resolve across repos
  — [Superblocks, A Single Dev Workspace for AI Agents, Part 1](https://superblocks.com/blog/a-single-dev-workspace-for-ai-agents), [DEV, Agent works one repo at a time](https://dev.to/firespark/agent-works-one-repo-at-a-time-work-doesnt-3588)
- PR linking: `just pr` runs `gh pr create` per repo, then a second pass appends sibling PR URLs to each description
  "since URLs only exist after creation"; the tracker ticket holds all PRs and does not auto-close until all merge
  — [Superblocks, A Single Dev Workspace for AI Agents, Part 1](https://superblocks.com/blog/a-single-dev-workspace-for-ai-agents)
- Same-named branches by tool: `mars branch feature-auth --tag backend` creates the branch across all repos with
  that tag
  — [DEV, The Missing Workspace Layer](https://dev.to/dean0x/the-missing-workspace-layer-for-agentic-polyrepo-development-pae)
- mabl: hooks block edits made in the wrong workspace and suggest the correct path
  — [mabl, AI agents across 75+ repos, Part 1](https://www.mabl.com/blog/how-we-built-a-system-for-ai-agents-to-ship-real-code-across-75-repos)
- Read-only by construction: "Make read-only repos read-only by removing their write tools, not by asking nicely."
  — [DEV, One Agent Per Repo](https://dev.to/just_an_electron/one-agent-per-repo-an-orchestration-pattern-for-multi-repo-ai-coding-49ba)
- Garth: each agent runs in Docker with all capabilities dropped, read-only root filesystem and a seccomp profile;
  it gets only the mounted worktree, a short-lived GitHub App token and an API key; `.git/hooks`, `.git/config`,
  `.github` and `.gitmodules` are mounted read-only; `garth token <repo>` mints a token for one repo
  — [Garth](https://github.com/ealt/garth)
- Claude Code worktree isolation blocks edits and git commands that target the main checkout, but does not track
  what shell commands write ("a command that writes into the main checkout without running git there, such as `cp`
  or a shell redirect, isn't refused"). Worktrees share the repository's `.git` directory and permission approvals
  with the main checkout
  — [Claude Code docs, worktrees](https://code.claude.com/docs/en/worktrees)
- Explicit-staging discipline when one session holds several repos: the tester prohibited `git add .`, `git add -A`,
  `reset`, `clean` and `stash`, and named the target repository, target file and changes not to include in the
  prompt
  — [Classmethod, Managing Multiple Repositories from Claude Code on the Web](https://dev.classmethod.jp/en/articles/claude-code-web-multi-repo-issues-prs/)

### Inferences

- A consistent convention across the sources: branch `<ticket>-<slug>` identical in every affected repo; worktree
  path `<workspace>/worktrees/<ticket>/<repo>`; PR title prefixed with the ticket; PR body carrying a generated
  "related PRs" block and the merge position.
- Claude Code's default worktree branch name (`worktree-<name>`) and its fixed base (default branch or HEAD) do not
  fit a shared feature-branch convention, so an orchestrator that wants same-named branches should create the
  worktrees itself with `git worktree add -b`.
- Two agents in the same repo (implementer and reviewer, or two task implementers) need the same rule as two repos:
  separate worktrees or strictly serial access.

### Gaps

- No source describes stacking several task branches inside one repo under a cross-repo feature branch.
- GitHub-native linking of PRs across repositories beyond text references and tracker integrations was not found.

## 6. Depth of the tree in a multi-repo setting

### Takeaway

Documented multi-repo setups are shallow: an orchestrator or manager, then per-repo or per-task workers, with
reviewers as siblings or as short-lived children. I found no published experience with a persistent "repo lead"
layer between the feature orchestrator and the implementers in coding work; the case for a middle layer comes from a
non-coding system and from general span-of-control arguments.

### Cited Findings

- Red Hat (2026-10-21): flat fan-out into a merger failed on questions needing cross-source reasoning ("Merging
  isn't coordinating."). A single orchestrator fixed that, then degraded as agents were added: "Rather than running
  out of context window, the orchestrator spreads its attention across too many choices", seen as over-broad
  delegation, wrong-specialist routing and duplicated work. The fix was domain teams, each with its own
  orchestrator, under a top-level orchestrator that chooses among "a handful of domains or subteams". "Structure
  scales, agent count doesn't." No numeric threshold or depth limit is given, and memory boundaries between layers
  are listed as an open question. The system is an enterprise troubleshooting assistant, not a coding pipeline
  — [Red Hat Developer, Scaling multi-agent systems with hierarchical orchestration](https://developers.redhat.com/articles/2026/10/21/scaling-multi-agent-systems-hierarchical-orchestration)
- Two-plane practice: manager (never writes code) and workers (one repo, one PR), with parallel sub-reviewers each
  covering one aspect (security, tests, silent failures, type design, edge cases)
  — [DEV, How I Manage 15+ Repos](https://dev.to/neil_agentic/how-i-manage-15-repos-with-claude-code-without-losing-my-mind-2ood)
- Telerik's roles: coordinator (reads the codebase, writes the plan, can use the more capable model), implementors
  (narrow tasks, cheaper models), verifier (checks results against the plan before human review), human reviewer.
  It warns that many agents feeding one reviewer creates a queue
  — [Telerik, Multi-Agent Orchestration for Software Delivery](https://www.telerik.com/blogs/multi-agent-orchestration-software-delivery-patterns-multi-repository-workflows)
- Tool-imposed depth: Claude Code subagents nest "up to three layers below the main conversation" by default; agent
  teams allow no nested teams
  — [Claude Code docs, subagents](https://code.claude.com/docs/en/sub-agents), [Claude Code docs, agent teams](https://code.claude.com/docs/en/agent-teams)
- The per-repo pattern's author advises restructuring deeper nesting "as orchestrator phases" and using a scripted
  workflow for large repeatable fan-out
  — [DEV, One Agent Per Repo](https://dev.to/just_an_electron/one-agent-per-repo-an-orchestration-pattern-for-multi-repo-ai-coding-49ba)
- Polygraph's model is two levels: a session that delegates to child agents in each repo (search snippet only)
  — [skills.sh, nx polygraph skill](https://skills.sh/nrwl/nx-ai-agents-config/polygraph)

### Inferences

- A repo lead earns its place when a repo's slice of the feature has several tasks: it holds that repo's plan and
  conventions, dispatches implementers and reviewers, and returns one handoff to the orchestrator. That keeps the
  feature orchestrator's context to N repo-level summaries instead of N times M task reports, which is the
  attention-dilution argument applied to code.
- For a repo whose slice is a single small change, a repo lead adds a summarising hop and nothing else; the
  orchestrator can dispatch the implementer directly. Depth can therefore vary per repo within one feature.
- Each extra layer is another lossy handoff. The cross-repo contract (the interface each repo must meet) should be
  passed down verbatim as a file reference, not re-summarised at each level.

### Gaps

- No direct evidence, positive or negative, on a repo-lead layer in coding pipelines. This is the weakest-sourced
  question in these notes.
- No data on how many repo children one feature orchestrator handles before quality drops.

## 7. Failure modes specific to multi-repo agent work, and mitigations

### Takeaway

The recurring failures are omission (a repo that needed a change was missed or left half-done), locally correct
changes that break unseen consumers, edits landing in the wrong checkout, and stale shared context. Mitigations that
sources report as effective are a dependency registry consulted at planning time, structural write boundaries, and a
combined-state check before merge.

### Cited Findings

- Omission and incompleteness dominate in the benchmark: failing to identify necessary changes, recognising them but
  leaving them unfinished, and touching the right repos without satisfying the request. Re-running repos
  independently "mainly recovers omitted work" but is weak at correcting earlier wrong implementations
  — [arXiv 2609.33382](https://arxiv.org/abs/2609.33382)
- Green per-repo checks with a broken system: agents fix their assigned piece and nobody owns the gaps; per-branch
  CI cannot see cross-repo interface problems. Mitigation: one integration run against the combined state of all
  branches ("The 11 branches have to exist together as one state")
  — [Telerik, Multi-Agent Orchestration for Software Delivery](https://www.telerik.com/blogs/multi-agent-orchestration-software-delivery-patterns-multi-repository-workflows)
- Agents ship locally correct code that breaks consumers they do not know exist; mabl's registry of dependencies,
  topics and table ownership is its mitigation, with "Any breaking change requires coordinated PRs." for shared
  utilities
  — [DEV, AI coding agents need cross-repo context](https://dev.to/danielwe/ai-coding-agents-need-cross-repo-context-the-teams-running-them-at-scale-are-already-building-it-ek0), [mabl, AI agents across 75+ repos, Part 1](https://www.mabl.com/blog/how-we-built-a-system-for-ai-agents-to-ship-real-code-across-75-repos)
- Wrong-workspace edits: mabl blocks them with hooks; Telerik and Garth use OS or container boundaries
  — [mabl, AI agents across 75+ repos, Part 1](https://www.mabl.com/blog/how-we-built-a-system-for-ai-agents-to-ship-real-code-across-75-repos), [Telerik, Multi-Agent Orchestration for Software Delivery](https://www.telerik.com/blogs/multi-agent-orchestration-software-delivery-patterns-multi-repository-workflows)
- Fabricated cross-repo references: mabl's grounding rule, "No fabricated references allowed."; agents must confirm
  paths with Glob or Read and quote line numbers from code they have read
  — [mabl, AI agents across 75+ repos, Part 1](https://www.mabl.com/blog/how-we-built-a-system-for-ai-agents-to-ship-real-code-across-75-repos)
- Locally optimised but architecturally poor choices, for example building a report without using existing API
  endpoints or shared services
  — [mabl, AI agents across 75+ repos, Part 1](https://www.mabl.com/blog/how-we-built-a-system-for-ai-agents-to-ship-real-code-across-75-repos)
- Stale local artifacts from wrong build order: "Miss the order, and your wrapper builds against stale native SDK
  artifacts."
  — [Agents meta-repo pattern](http://blog.rubbad.uk/2026/03/05/blog-agents-meta-repo-pattern.html)
- Stale shared context: "Documentation drift is real."; "The most dangerous documentation is documentation that
  used to be correct". Per-repo CLAUDE.md files decay without a maintainer. Mitigations: a Verify / Update / Suggest
  contract in `AGENTS.md`, CODEOWNERS on the cross-repo file, generated staleness markers
  — [Agents meta-repo pattern](http://blog.rubbad.uk/2026/03/05/blog-agents-meta-repo-pattern.html), [Superblocks, A Single Dev Workspace for AI Agents, Part 1](https://superblocks.com/blog/a-single-dev-workspace-for-ai-agents), [DEV, AI coding agents need cross-repo context](https://dev.to/danielwe/ai-coding-agents-need-cross-repo-context-the-teams-running-them-at-scale-are-already-building-it-ek0)
- Rules bleeding between repos when one context holds several repos' conventions, including edit permissions
  — [DEV, One Agent Per Repo](https://dev.to/just_an_electron/one-agent-per-repo-an-orchestration-pattern-for-multi-repo-ai-coding-49ba)
- Credentials and permission scope: Copilot on GitHub Actions is limited to the task's repository and its MCP
  context defaults to that repository; Cursor's multi-repo cloud agents need read-write on every dependent repo;
  Garth mints short-lived per-repo GitHub App tokens. In Claude Code, an agent-team teammate starts with the lead's
  permission mode, including `bypassPermissions`, and permission approvals made in a worktree are saved for the
  whole repository
  — [GitHub Docs, about the coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent), [Cursor docs, cloud agents](https://cursor.com/docs/cloud-agent), [Garth](https://github.com/ealt/garth), [Claude Code docs, agent teams](https://code.claude.com/docs/en/agent-teams), [Claude Code docs, worktrees](https://code.claude.com/docs/en/worktrees)
- Tool reliability across repos: an MCP server "returned only pagination metadata instead of actual pipeline data";
  the author's conclusion is that "shell scripts are more reliable than MCP tools" for production steps
  — [Agents meta-repo pattern](http://blog.rubbad.uk/2026/03/05/blog-agents-meta-repo-pattern.html)
- Automation loops across PRs: mabl stops auto-fix when the last two commits are both tagged `[auto-fix]` and does
  not retry a fix the author reverted
  — [mabl, AI agents across 75+ repos, Part 1](https://www.mabl.com/blog/how-we-built-a-system-for-ai-agents-to-ship-real-code-across-75-repos)

### Inferences

- Duplicated or inconsistent shared types follow from two repo agents each deriving the interface from prose. The
  mitigation implied by the sources is to fix the contract once at orchestrator level, in a machine-checkable form,
  before any repo agent starts, and to hand every agent the same file.
- A cheap completeness check falls out of WideSWE's failure list: before closing the feature, the orchestrator
  compares the set of repos in the plan with the set of repos that have a PR, and each PR with its handoff's
  interface requirement.

### Gaps

- No source quantifies wrong-repo edits or duplicated shared types specifically; they appear as anecdotes.
- Stale local copies of versioned shared packages (an agent testing against an old published version instead of the
  sibling branch) is not documented in an agent context; only the build-order variant above was found.

## 8. Micro-frontend specifics

### Takeaway

Agent-specific guidance for polyrepo micro-frontends is thin: one tutorial-style guide, plus general micro-frontend
material that predates agents. What exists says to change the shared contract first, then fan out per remote, pin
shared dependency versions in the shell, and encode each remote's exposed modules in its own instruction file.

### Cited Findings

- Host and remote instruction files (2026-05-31, updated 2026-11-23; tutorial, monorepo-flavoured with Nx): the
  shell's `AGENTS.md` states that remote entry URLs are managed by the deployment manifest and not edited directly,
  that adding a remote requires updating both the federation config and the routing table, and that "Shared
  dependencies in `shared` config must pin exact versions to prevent singleton violations." Each remote's
  `AGENTS.md` lists its exposed modules and build verification command, with the rules "Changing the public API of
  exposed modules requires updating the type contract in `libs/shared-types` first." and "Do not add host-specific
  dependencies; this remote must remain independently deployable."
  — [Codex Knowledge Base, micro-frontend guide](https://codex.danielvaughan.com/2026/05/31/codex-cli-micro-frontend-development-module-federation-2-nx-independent-deployments/)
- Same source, sequencing a change across shell, remote and shared library: update the shared type contract first;
  an orchestrator spawns per-team subagents that update each remote in parallel and run that team's tests; a CI
  workflow triggered by changes to the shared types rebuilds affected shell and remotes. For polyrepo it suggests
  `--add-dir` across the shell, remotes and shared-types repositories. Singleton mismatches are called "the most
  common runtime failure in federated architectures" ("the host ends up with two instances and hooks break");
  agents can validate `mf-manifest.json` to catch wrong `remoteEntry` URLs or version mismatches, and a
  post-tool-use hook can flag mismatched shared versions
  — [Codex Knowledge Base, micro-frontend guide](https://codex.danielvaughan.com/2026/05/31/codex-cli-micro-frontend-development-module-federation-2-nx-independent-deployments/)
- Nx's micro-frontend guidance: deployments are not atomic, so mismatched shared library versions are a leading
  failure mode; share as few libraries as possible (search snippet only; not agent-specific)
  — [Nx docs, micro-frontend architecture](https://nx.dev/technologies/module-federation/concepts/micro-frontend-architecture)
- Design systems are usually delivered as versioned packages, with runtime federation reserved for larger vertical
  slices; breaking changes need a migration path because several micro-frontend versions run at once; AWS suggests
  feature flags to roll out a new design-system version gradually (search snippets only; not agent-specific)
  — [Steve Kinney, design systems across microfrontends](https://stevekinney.com/courses/enterprise-ui/design-systems-across-microfrontends), [AWS Prescriptive Guidance, micro-frontends styling](https://docs.aws.amazon.com/prescriptive-guidance/latest/micro-frontends-aws/styling-css.html)
- The dependency-order lesson from a non-web polyrepo applies directly: shared resources first, then the libraries
  built on them, then the wrappers; merge requests are merged in that order
  — [Agents meta-repo pattern](http://blog.rubbad.uk/2026/03/05/blog-agents-meta-repo-pattern.html)
- Toolchain resolution across sibling checkouts (pnpm, go workspaces, Cargo) works when worktrees are real sibling
  directories in one task directory, and fails with scattered `--add-dir` paths
  — [DEV, Agent works one repo at a time](https://dev.to/firespark/agent-works-one-repo-at-a-time-work-doesnt-3588)

### Inferences

- For a feature touching a shared library, a remote and the shell, the repo agents are not independent: the shared
  library's agent must finish (or at least fix its public API and version) before the remote's agent can verify, and
  the shell's agent depends on the remote's exposed-module contract. The fan-out is therefore staged by the
  dependency graph, not fully parallel.
- A versioned shared package adds a choice the plan must state per feature: consumers build against the sibling
  worktree (link or workspace override) during development and against a published pre-release version for
  verification, or wait for a release. Leaving this implicit is how a repo agent ends up testing against a stale
  published version.
- A micro-frontend repo card needs fields a service card does not: role (shell, remote, shared library, design
  system), exposed modules and their type contract, consumed remotes, shared singletons with pinned versions, and
  how remote URLs are resolved (manifest, environment).

### Gaps

- No source describes agents working a module-federation, single-spa or native-federation change across separate
  repositories end to end; the one guide found is written around an Nx workspace layout and extended to polyrepo in
  a sentence.
- Nothing found on native federation or single-spa with agents, on stale federated type packages, or on agents
  handling shell routing changes.
- No case study from a company running agents across many micro-frontend repos was found.
