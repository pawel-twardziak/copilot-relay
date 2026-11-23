# Cross-repo engineering coordination for parallel AI implementers: contracts, ordering, integration verification, shared state

Research date: 2026-11-23. Scope: polyrepo (one repo per microservice / micro-frontend), implementers are AI coding agents in an orchestrator tree.

Reading guide for the report writer:

- "Opened" = the page was fetched and read in this session. "Snippet only" = the claim comes from a search-result summary and the page was not opened; treat it as a lead, not as verified.
- Contract-testing and API-evolution fundamentals (Pact docs 2022, Parallel Change 2014, microservices.io) are old but still the current canonical references; nothing found in 2025-2026 material contradicts them.
- Most 2026 material about agents is vendor content or individual blog posts. No independent, measured study of contract gates used with AI agents across repos was found.
- Items I know from prior knowledge but did not verify in this session are listed under "Gaps" with a pointer URL, not under "Cited Findings".

## 1. Contract-first development: how contracts are fixed, where they live, how they are versioned and distributed

### Takeaway
Every 2026 write-up about parallel coding agents that was found agrees on one rule: write the contract first, freeze it, and let each agent build against the frozen reference instead of against the other agent's in-flight code. The sources cover the mechanics for protobuf (`buf breaking`, Buf Schema Registry) and OpenAPI (`oasdiff`) well; where the contract lives in a polyrepo is addressed only by one blog post ("a repo both agents can import from") and otherwise had to be inferred.

### Cited Findings
- Core claim for agents: "Define the contract between them and dispatch both now." Both agents work against "a frozen reference, not against each other's in-flight code." The contract is "the set of types, schemas, folder shapes, and provider interfaces", not only a TypeScript interface. The human dispatcher owns it and it should live in a repo both agents can import from. Opened; no publish date on page — [Contracts Parallelize Agents, J. Phoenix](https://understandingdata.com/posts/contracts-parallelize-agents/)
- Test for whether work can be split: "can I describe every value crossing this seam without reading either side's implementation?" If the data shape is the open question, both agents should block until it is settled. Under-specification "bites later when one agent assumes a field exists and the other never emits it"; advice is "Over-specify early" and "Version contracts explicitly." — [Contracts Parallelize Agents](https://understandingdata.com/posts/contracts-parallelize-agents/)
- `buf breaking` checks a protobuf schema against an earlier version (BSR module, Git repository, tarball, Buf image) for changes that break "clients, servers, or the code generated from those schemas." Example: `buf breaking --against '.git#branch=main'`. Opened — [Buf docs: breaking change detection](https://buf.build/docs/breaking/)
- Buf rule categories, strictest to loosest: FILE (default; generated source per file), PACKAGE (generated source per package), WIRE_JSON (binary wire or JSON encoding), WIRE (binary wire only). "Passing a stricter category implies passing every looser one." — [Buf docs](https://buf.build/docs/breaking/)
- Registry-side enforcement: BSR server-side breaking checks "catch anything CI missed"; a push that would break consumers "enters a review flow where repository owners approve or reject the change before it reaches production." — [Buf docs](https://buf.build/docs/breaking/)
- `oasdiff` is a "Command-line tool to compare and detect breaking changes in OpenAPI specs." Commands: `breaking` (only client-breaking changes), `changelog` (all consumer-affecting changes), `diff` (full machine-readable diff). Inputs can be git revisions ("compare against a branch, tag, or commit"); `breaking-files` checks changed specs against a git ref; a GitHub Action exists; the README links OpenAPI 3.1 and 3.2 support. Opened — [oasdiff README](https://github.com/oasdiff/oasdiff)
- Ownership models: consumer-driven (consumer teams define contracts through tests; generating a pact from a Swagger document by hand "would be like marking your own exam"), schema-first (provider or API design team controls the spec), bi-directional (both publish independently). Opened, vendor guide dated 2026-06-30 — [Augment Code: API Contract Testing with Agent-Authored Specs](https://www.augmentcode.com/guides/api-contract-testing-agent-authored-specs)
- Agent rule seen in a published skill: the OpenAPI file is read-only for the front-end agent, TypeScript types are generated from it, and the back-end agent updates the spec and reruns codegen when it changes. Snippet only — [backend-frontend-contracts skill](https://lobehub.com/skills/llascola-web-backend-backend-frontend-contracts)

### Inferences
- For a polyrepo with an orchestrator, three placements are possible, and the sources support only the general principle (one frozen, importable reference), not a specific choice:
  1. Provider repo owns the spec file (`openapi.yaml`, `*.proto`) and CI publishes a versioned artifact (npm types package, BSR module, spec in a registry). Fits schema-first; consumers pin a version.
  2. Dedicated contracts repo. Fits events and cross-cutting types shared by several providers; costs one more repo and one more merge in every feature.
  3. Per-feature "contract change set" held by the orchestrator (a diff against each provider's spec plus the MFE contract), copied read-only into every worker's workspace and later committed to the owning repo by that repo's agent. This is what the agent write-ups effectively describe ("the human dispatching the agents should own it").
- Practical combination: the durable source of truth stays where it is today (provider repo or registry); for the duration of the feature the orchestrator holds contract version N+1 as a frozen file with an explicit version field, and `oasdiff breaking` / `buf breaking` against `main` is run on it before any worker starts. A non-breaking result means consumers and provider can proceed in any order; a breaking result forces an expand/contract plan (section 4).
- Distribution to consumer agents before the provider has merged: generated types from the frozen spec file (path or git ref dependency), not a published package version, because nothing is published yet.

### Gaps
- No source found that compares provider-repo vs contracts-repo vs registry placement with evidence. The search for cross-repo spec versioning in agent setups returned nothing direct.
- Not verified this session (prior knowledge, check before citing): AsyncAPI for event contracts (asyncapi.com/docs), TypeSpec as a single source that emits OpenAPI / JSON Schema / protobuf (typespec.io/docs), GraphQL federation schema checks against a registry (Apollo GraphOS `rover subgraph check`; Hive; Cosmo), Confluent Schema Registry compatibility modes (BACKWARD, FORWARD, FULL) for Avro/JSON Schema/protobuf events, Buf generated SDKs served from the BSR. The Buf page opened did not describe SDK distribution.

## 2. Contract testing as an automatic gate (Pact, can-i-deploy, bi-directional, schema diff) and reports of use with AI agents

### Takeaway
The gate mechanics are mature and well documented: a broker records which consumer version was verified against which provider version, and `can-i-deploy` returns exit code 0 or 1 before a deployment. Pending pacts are the documented way to let a consumer publish new expectations before the provider implements them without breaking the provider build. Evidence of use with AI agents is limited to vendor tooling (PactFlow AI, SmartBear MCP exposing `can_i_deploy` to agents) and a vendor guide; no independent report of an agent tree gated by these tools was found.

### Cited Findings
- `can-i-deploy` checks whether a version of an application is compatible with the versions of the other applications already in an environment, using the "Matrix" ("the grid created when you create a table of all the consumer and provider versions" tested against each other). Commands: `pact-broker can-i-deploy --pacticipant NAME --version VERSION --to-environment ENV` before deploying; `pact-broker record-deployment --pacticipant NAME --version VERSION --environment ENV` after. Exit code 0 = yes, 1 = no. Supports polling for results, ignoring specific integrations, and a dry-run mode. Page last updated 2022-10-05; still the current doc. Opened — [Pact docs: Can I Deploy](https://docs.pact.io/pact_broker/can_i_deploy)
- The page gives no fixed deployment order between consumer and provider; the order follows from the matrix check per application. — [Pact docs: Can I Deploy](https://docs.pact.io/pact_broker/can_i_deploy)
- Pending pacts: with `enablePending`, a changed pact does not fail the provider build until it has been verified successfully once; "the build will only fail when it needs to prevent a breakage to an existing integration." Pending status is per provider branch. The consumer can publish new expectations first; the provider build stays green; the consumer's own deployment stays blocked by `can-i-deploy` until the provider supports the interaction. New interactions "should have been done in a feature branch." WIP pacts "always have the pending flag set to true." Opened — [Pact docs: Pending pacts](https://docs.pact.io/pact_broker/advanced_topics/pending_pacts)
- Recommended gate flow restated in a 2026 guide: consumer publishes a pact for a specific version; provider verifies and records results in the matrix; `can-i-deploy` checks compatibility with the target environment. "Teams should deploy the consumer only after verification against the production version of the provider." Include the git commit SHA in application versions; use one broker ("Multiple broker instances split history and break `can-i-deploy` logic"); trigger provider verification by a `contract_content_changed` webhook. Opened, vendor — [Augment Code guide, 2026-06-30](https://www.augmentcode.com/guides/api-contract-testing-agent-authored-specs)
- Bi-directional contract testing (BDCT): provider side is an OpenAPI document that "must" match the code; consumer side is a pact generated from API mocks ("If you can programmatically access your mocks, you can generate a pact file from it"). Consumer mock tools named: WireMock, MSW, Cypress, Mountebank. Provider tooling named: Swashbuckle, springdoc-openapi, RestAssured, Dredd, Postman. The feature is "exclusive to PactFlow" and not supported by the open-source Pact Broker. Opened, vendor page — [PactFlow: Bi-Directional Contract Testing](https://pactflow.io/bi-directional-contract-testing/)
- BDCT weakness: "If the OAS drifts from the implementation, BDCT will miss it." Conformance checks of the implementation against the OpenAPI document (PactFlow Drift, Dredd, Schemathesis) are named as the fix. — [Augment Code guide](https://www.augmentcode.com/guides/api-contract-testing-agent-authored-specs)
- Agent-specific risk: generated contract tests may encode current behaviour including bugs; agent-generated contracts are drafts and "human approval should remain the deployment authority." — [Augment Code guide](https://www.augmentcode.com/guides/api-contract-testing-agent-authored-specs)
- Matt Fellows (PactFlow co-founder), 2025-08-07: generated tests can end up "just testing the bugs as opposed to finding the bugs"; "the future is moving towards autonomous contract testing with that human in the loop design"; PactFlow is "investing in things like MCP" to give agents access to contract data. Opened; older than a year, direction since confirmed by the MCP docs below — [TestGuild DevOps Toolchain ep. 198](https://testguild.com/podcast/p198-matt/)
- The SmartBear MCP server exposes a `contract-testing_can_i_deploy` tool to agents, next to AI generation and review tools; the AI tools require PactFlow Cloud, not the open-source broker. Snippet only — [Pact docs: SmartBear MCP Server](https://docs.pact.io/ai_tools/smartbear-mcp)
- Pact open-source update of 2026-05-22 mentions skills and agents that assist with contract testing. Snippet only — [Pact Open Source Update, May 2026](https://docs.pact.io/blog/2026/05/22/pact-open-source-update-may-2026)
- Schema-diff gates: `oasdiff breaking` and `buf breaking --against` compare a changed spec with a git ref and fail on breaking changes (details in section 1). — [oasdiff](https://github.com/oasdiff/oasdiff); [Buf docs](https://buf.build/docs/breaking/)

### Inferences
- Two gate levels fit an agent tree, with different costs:
  - Level A, no extra infrastructure: schema diff (`oasdiff breaking` / `buf breaking`) on the frozen contract against provider `main`, plus provider conformance against the spec (Prism proxy, Schemathesis, Dredd) and consumer mocks generated from the same spec. This is a home-made BDCT without a broker. It catches structural breaks, not behavioural misreadings.
  - Level B, broker: Pact with pending pacts on feature branches and `can-i-deploy` as the merge/deploy gate. It catches what the consumer really uses, and the matrix gives the orchestrator a machine-readable "is this pair compatible" answer (exit code).
- The pending-pact semantics map directly onto parallel agents: the consumer agent publishes expectations from its feature branch; the provider agent's build is not broken by them; the orchestrator's merge gate for the consumer repo is `can-i-deploy`.
- Because agents tend to write tests that mirror their own implementation, the contract tests (or the examples in the spec) should be authored in the contract phase by the orchestrator or a separate agent, not by the implementer of either side. This follows from the "marking your own exam" and "testing the bugs" warnings; no source states it as a tested practice.

### Gaps
- No independent case study of `can-i-deploy` gating agent-authored changes; the search returned vendor pages only.
- Spring Cloud Contract was not researched this session (prior knowledge: provider-side contract DSL, generated stubs published as a Maven artifact and run by Stub Runner; JVM-centric). Pointer: spring.io/projects/spring-cloud-contract.
- The PactFlow docs page for BDCT workflow steps returned HTTP 404 at two URL forms; the step list (provider publishes OAS plus self-verification evidence, PactFlow compares statically) is therefore not confirmed from the docs, only from the marketing page and the Augment guide.

## 3. Mocks and stubs generated from the contract, so front-end and back-end agents work in parallel

### Takeaway
The documented workflow is: one spec, a generated mock for the consumer (Prism server or generated MSW handlers), and the same spec used to check the real provider (Prism validation proxy). The sources describe setup well and drift poorly; the one firm pitfall with evidence is that agent sessions generating front-end and back-end separately produce schema drift that breaks end-to-end tests.

### Cited Findings
- Prism (open source 3.x is "the current version") provides "mocking, request validation, and content negotiation" from "OpenAPI v3.1, OpenAPI v3.0, OpenAPI v2.0 (formerly Swagger) and Postman Collections." Its proxy mode can "check for discrepencies between your API implementation and the OpenAPI document" by "letting you funnel HTTP traffic through it with the `prism proxy` command", e.g. `prism proxy examples/petstore.oas2.yaml https://petstore.swagger.io/v2`. Opened; no release date visible on the page — [stoplightio/prism README](https://github.com/stoplightio/prism)
- A consumer agent that mocks against the contract does not wait for the producer; when the producer finished, the author "pointed Agent B's provider at the real manifest. Nothing else changed." The mock built against the contract can become an integration-test fixture. — [Contracts Parallelize Agents](https://understandingdata.com/posts/contracts-parallelize-agents/)
- With BDCT the consumer's mocks (MSW, WireMock, Cypress, Mountebank) are turned into a pact and compared with the provider's OpenAPI document, which makes the mock itself the checked artifact. — [PactFlow BDCT](https://pactflow.io/bi-directional-contract-testing/)
- Generators that turn an OpenAPI document into MSW handlers exist (e.g. `openapi-to-msw`, `msw-auto-mock`); MSW runs in the browser or Node without a separate server. Snippet only — [openapi-to-msw](https://npmjs.com/package/openapi-to-msw); [msw-auto-mock](https://www.npmjs.com/package/msw-auto-mock)
- Agents "often break E2E tests through schema drift when frontend and backend are generated in separate sessions." Snippet only — [Augment Code: Why AI Coding Agents Fail E2E Tests](https://www.augmentcode.com/guides/why-ai-coding-agents-fail-e2e-tests)
- An OpenAPI spec can list possible status codes, but "the specification alone cannot say which inputs produce which status code." — [Augment Code guide](https://www.augmentcode.com/guides/api-contract-testing-agent-authored-specs)

### Inferences
- Pitfalls that follow from the findings (none measured in a source):
  - Hand-edited mocks drift from the spec. Generated handlers must be regenerated, never edited; scenario overrides belong in a separate file.
  - A spec-derived mock is structurally right and behaviourally empty (random or example data, no state, no rule for which input gives which status). The contract therefore needs named examples per scenario (happy path, validation error, not found, auth failure), and both the mock and the provider tests should use those same examples.
  - The mock proves the consumer against the spec; it proves nothing about the provider. The symmetric check (Prism proxy, Schemathesis or Dredd against the running provider branch) has to be a task in the provider repo's plan.
- For the agent tree: the mock/type generation step belongs to the contract phase and its outputs are read-only inputs to the workers, so no worker can "fix" a mock to make its tests pass.

### Gaps
- No source found that documents mock drift in agent workflows with numbers. WireMock and Pact stub server were not researched this session (prior knowledge: WireMock can serve stubs from recorded mappings and has OpenAPI-based tooling; `pact-stub-server` serves the interactions of a pact file as a stub).

## 4. Ordering and compatibility: expand/contract, flags, deployment order, migrations, shared libraries, the cross-repo DAG

### Takeaway
The canonical technique is Parallel Change (expand, migrate, contract): make every cross-repo change additive first so that each repo can be merged and deployed independently, and remove the old form in a later, separate step. With an additive contract, the only hard ordering constraint is that a consumer is not deployed before a provider version that satisfies it, which is exactly what `can-i-deploy` checks.

### Cited Findings
- Parallel Change (Danilo Sato, 2014-05-13, still the canonical reference): Expand = "you augment the interface to support both the old and the new versions"; Migrate = "you update all clients using the old version to the new version"; Contract = "you perform the contract phase to remove the old version". Code can be released in any of the three phases. Applies to database refactorings and to remote APIs (evolve endpoints without explicit versioning; follow Postel's Law when expanding a payload). Drawbacks: the supplier supports two versions during migration; skipping the contract phase leaves a worse state than before. Opened — [martinfowler.com: ParallelChange](https://martinfowler.com/bliki/ParallelChange.html)
- A consumer can publish new expectations before the provider implements them (pending pacts), but its deployment stays blocked by `can-i-deploy` until the provider supports them. — [Pact docs: Pending pacts](https://docs.pact.io/pact_broker/advanced_topics/pending_pacts)
- "Teams should deploy the consumer only after verification against the production version of the provider." — [Augment Code guide](https://www.augmentcode.com/guides/api-contract-testing-agent-authored-specs)
- Dependency graphs between changes in different repos are one-way in Zuul: "Change A may depend on B, but B may not depend on A" (cycles are opt-in via `queue.allow-circular-dependencies`). — [Zuul: Project Gating / cross-project dependencies](https://zuul-ci.org/docs/zuul/latest/gating.html)
- Agent task lists with dependency edges exist in current tooling: tasks have statuses pending / in_progress / completed / blocked, and "any blocked tasks that depended on it automatically unblock" when a dependency completes. Opened, 2026-03-26 — [Addy Osmani: The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)
- Shared-library coupling in micro-front-ends: when a shared singleton library changes its API, the failure usually shows at runtime, not at build time. Snippet only — [The Micro-Frontend Chaos (and how to solve it)](https://itnext.io/the-micro-frontend-chaos-and-how-to-solve-it-960b0a90c58)

### Inferences
- A cross-repo plan can be expressed as a DAG with typed nodes `{repo, task, phase}` and typed edges. Proposed edge types, derived from the findings above:
  - `contract -> *`: every implementation task depends on the frozen contract version (hard, before start).
  - `lib publish -> dependents`: a shared library or types package must be published (or be consumable by git ref) before dependents can build (hard, before start, unless the dependent pins a branch ref).
  - `db expand -> provider code`: within the provider repo (hard, before start).
  - `provider deployed -> consumer deployed`: a deploy-order edge only; it does not block the consumer agent from starting, because the consumer works against mocks.
  - `all migrate tasks merged -> contract/cleanup`: the removal step is a separate, later task (often a separate PR after the feature is live).
- Proposed waves:
  - Wave 0, serial, orchestrator: contract change set (API, events, MFE exposes/props/events), schema-diff check against `main`, generated types and mocks, ordering plan, flag name.
  - Wave 1, parallel across repos: provider (migration expand, then endpoint behind a flag); consumers and remotes against mocks and generated types; shell changes (routes, slots). Serial inside a repo where tasks touch the same files.
  - Wave 2, serial, verifier: compose all feature branches, run contract checks and cross-repo end-to-end tests (section 6).
  - Wave 3, merge and deploy order: shared lib, DB expand, provider, consumers/remotes, shell, flag on. Later: contract phase (remove old field/endpoint, drop column, remove flag).
- What can run in parallel: everything whose incoming edges are only "contract frozen". What cannot: tasks on the same repo touching the same files (Osmani's "One file, one owner"), dependents of an unpublished shared library, and the cleanup phase.
- If the schema diff reports a breaking change, the orchestrator should rewrite the plan as expand/contract instead of coordinating a simultaneous merge; polyrepo tooling does not give atomic cross-repo merges (section 7).

### Gaps
- Feature toggles were not re-read this session. Prior knowledge: Pete Hodgson's article on martinfowler.com (2017) defines release toggles as short-lived flags that let unfinished code ship dark; pointer: martinfowler.com/articles/feature-toggles.html.
- No source found that gives a DAG notation for cross-repo agent plans, or evidence on how shared-library version bumps propagate in agent workflows (Renovate/Dependabot-style propagation was not researched).
- Database migration ordering: only the general statement in Parallel Change was verified; the detailed catalogue (Evolutionary Database Design, Sadalage and Fowler) was not opened.

## 5. Micro-frontend specifics: shell-remote contracts, detecting breaks, verifying a remote against the shell locally

### Takeaway
A shell-remote contract has more parts than an API contract (exposed modules and their props, shared dependency versions, routes, events, design-system version), and most of them are checked only at runtime unless the team adds checks. Module Federation 2.0 closes the largest gap for TypeScript by generating and fetching the remote's types, so an exposed-module signature change becomes a compile error in the host.

### Cited Findings
- Module Federation 2.0 (`@module-federation/enhanced`) generates types for `exposes` at build time and type hinting is on by default: "Module Federation artifacts also generate types and enjoy hot-reloading of types." The consumer maps `./@mf-types/*` in `tsconfig.json` `paths` and fetches the producer's types automatically; `loadRemote` calls are typed when `@mf-types` is in `include`; nested and dynamic remotes are supported; startup order of producer and consumer does not matter. Controlled by the `dts` and `dev` options; debug with `FEDERATION_DEBUG=true` and `.mf/typesGenerate.log`. Opened — [module-federation.io: Type Hinting](https://module-federation.io/guide/basic/type-prompt.html)
- Shared dependencies: Module Federation generally picks the highest compatible shared version; a singleton cannot fall back to another copy on conflict; `strictVersion` makes a mismatch fail fast. Snippet only — [Angular Architects: Getting Out of Version-Mismatch-Hell with Module Federation](https://www.angulararchitects.io/blog/getting-out-of-version-mismatch-hell-with-module-federation)
- Failure modes listed in a testing guide: remote load failures, shared-dependency version conflicts, and interface changes the shell discovers only at runtime; it recommends a contract test layer that checks a remote's exports against what the shell expects, plus integration and E2E layers. Snippet only — [Testing Micro-Frontends with Module Federation](https://helpmetest.com/blog/micro-frontend-testing-module-federation/)
- The runtime rejects a shared React version that does not satisfy a remote's requirement, which surfaces drift between independently deployed remotes. Snippet only — [S. Kinney: Runtime composition exercise](https://stevekinney.com/courses/enterprise-ui/runtime-composition-exercise)
- Known bug report: a shared deep dependency resolved to one version although other dependencies need a different one. Snippet only — [webpack issue 15971](https://github.com/webpack/webpack/issues/15971)
- Nx documents the Module Federation shared API as keeping one copy of each dependency. Snippet only — [Nx: Manage library versions with Module Federation](https://nx.dev/concepts/module-federation/manage-library-versions-with-module-federation)

### Inferences
- A shell-remote contract file for an agent plan should list, per remote: exposed module names and their prop/return types; `shared` entries with `singleton`, `requiredVersion`, `strictVersion`; route prefix owned by the remote; custom event names with payload schema (JSON Schema or a TypeScript type in a shared types package); design-system package version range. Only the first is covered by MF 2.0 type generation; the rest need explicit checks.
- Checks that turn runtime breaks into build or test failures:
  - Host type-check against the remote branch's generated `@mf-types` (point the host's remote URL at the remote agent's local dev server or built artifact).
  - A script comparing `shared` version ranges across shell and remotes, with `strictVersion` on singletons so that a mismatch throws instead of silently loading a second copy.
  - A smoke test that loads each exposed module through the real shell (Playwright) with back-ends mocked from the API contract.
- Local verification of a remote against the shell: run the remote's dev server from its feature worktree, run the shell (from `main` or its own feature branch) with the remote URL overridden to localhost, and run the shell's E2E smoke. In an agent tree this is a verifier task, since it needs two repos checked out.

### Gaps
- single-spa (import maps, shared dependencies, parcels) and micro-frontends.org (custom events, custom elements as the contract) were not opened this session; prior knowledge only. Pointers: single-spa.js.org/docs, micro-frontends.org.
- No source found on contract testing of custom events or shared state between micro-front-ends with a standard tool, and none on agents working on shell and remotes in parallel. Whether the Module Federation manifest (`mf-manifest.json`) is used for compatibility checks was not covered by the page opened.

## 6. Integration verification before merge, and who runs it in an agent tree

### Takeaway
Testing each PR alone does not test the feature: a contract mismatch between two PRs can pass both per-PR checks and fail after merge. The documented answer in 2026 is a combined pre-merge environment that contains the branch of every repo in the feature; for agents, several vendors argue that verification infrastructure, not code generation, is the bottleneck.

### Cited Findings
- "testing each pull request on its own never runs the feature end to end." Each PR's preview pairs its change with baseline versions of the other services, so a contract mismatch between PRs can pass both checks and fail only after merge. Opened; vendor; no publish date (copyright 2026) — [Signadot: Collaborative pre-merge testing for multi-PR features](https://signadot.com/blog/collaborative-pre-merge-testing-for-multi-pr-features)
- Signadot mechanism: each PR gets a sandbox that forks only the service it changes; a route group is "a routing key shared by several sandboxes"; requests carry the key in the `baggage` header, propagated through OpenTelemetry context propagation; unforked services come from a shared baseline. PRs from different repos are linked by an `epic` label set with a `/epic EPIC-42` PR comment. Limits: two sandboxes forking the same workload cannot be in one route group; services must propagate the header. Cost claim: "A feature that changes two services runs two extra pods, however many services the application has." — [Signadot blog](https://signadot.com/blog/collaborative-pre-merge-testing-for-multi-pr-features)
- Vendor argument: without infrastructure to test against real dependencies, developers become the verification layer and integration issues appear only after merge; Signadot exposes sandboxes, route groups and preview endpoints to coding agents through an MCP server. Snippet only — [Signadot: AI development](https://signadot.com/product/ai-development)
- A team write-up describes giving every PR, human- or agent-authored, its own short-lived environment, because cross-service changes (a proto change touching two services) otherwise have no pre-merge test surface. Snippet only — [Nirvana Tech: Every pull request gets its own environment](https://www.nirvanatech.com/blog/every-pull-request-gets-its-own-environment-heres-the-system-we-built-to-do-it)
- Zuul tests a change together with its cross-repo dependencies before merge: in independent (check) pipelines "your change will be tested with its dependencies"; in dependent (gate) pipelines changes are tested speculatively with the changes ahead of them. — [Zuul: Project Gating](https://zuul-ci.org/docs/zuul/latest/gating.html)
- Agent quality gates in current tooling: a `TaskCompleted` hook runs lint and tests before a task is marked done; a permanent read-only reviewer teammate is triggered on each task completion so that "The lead only sees green-reviewed code"; about one reviewer per 3-4 builders. — [Addy Osmani: The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)
- Flaky environments become systemic with many agents: "forty agents hit the same flaky test simultaneously." — [Addy Osmani](https://addyosmani.com/blog/code-agent-orchestra/)
- The one-agent-per-repo write-up gives no method for verifying a cross-repo change. Opened; posted June 16 (year not shown, author joined 2026) — [One Agent Per Repo, dev.to](https://dev.to/just_an_electron/one-agent-per-repo-an-orchestration-pattern-for-multi-repo-ai-coding-49ba)

### Inferences
- Verification layers for an agent tree, cheapest first:
  1. Per repo, by the implementer: unit tests, consumer tests against the generated mock, provider conformance against the frozen spec.
  2. Per contract, by the orchestrator or a script: schema diff and, if a broker exists, `can-i-deploy` per pair.
  3. Per feature, by a dedicated integration/verifier agent: start all feature branches together (docker compose with the feature worktrees mounted or built, or a sandbox/preview system), run cross-repo E2E, load remotes in the real shell.
- A dedicated verifier agent is justified by three points from the sources: no single repo agent sees more than its repo; implementers' own tests mirror their own reading of the contract; and the combined environment needs every worktree. The verifier should not fix code: it reports each failure against a contract clause and a repo, and the orchestrator routes the fix to that repo's agent.
- Running layer 3 only once at the end reproduces the "integration discovered at the end" failure. A cheap early layer 3 run ("walking skeleton": one endpoint, one screen, wired through all repos) right after wave 1 starts would surface interpretation differences while changes are still small. No source measured this for agents.
- Shared local environments need isolation per feature (ports, compose project name, database) or parallel features collide, as the flaky-environment observation suggests.

### Gaps
- No independent benchmark of preview environments for agent-authored PRs; sources are vendor content (Signadot, Render, Fly.io, Qovery, Encore). The New Stack article on merge gates for coding agents returned HTTP 403 and could not be read.
- Tilt, Skaffold, Testcontainers, devcontainers and docker compose for multi-repo local stacks were not researched this session; nothing found that documents which agent in a tree runs them.

## 7. Coordinating PRs and merges across repos

### Takeaway
No mainstream tool gives an atomic merge across independent repos; even Gerrit states that cross-repo topic submission can end partially submitted. The realistic model is ordered, individually safe merges (possible because the change is additive), with links between the PRs and a pre-merge combined test. Zuul's `Depends-On` is the most complete existing design for declaring and testing cross-repo dependencies.

### Cited Findings
- Zuul: add `Depends-On: <change-url>` to the commit message (Gerrit) or to the pull request description (GitHub: "the `Depends-On:` footer must be in the _Pull Request_ description"). Multiple lines allowed; cross-system dependencies are supported ("a Gerrit change may depend on a GitHub pull request"). In a gate pipeline, if A depends on B, "B will appear first and A will follow"; if B fails, "both B and A will be removed from the pipeline." Dependencies enqueue together only if the projects share a change queue; otherwise "the first will be required to merge before the second can be enqueued." Opened — [Zuul: Project Gating](https://zuul-ci.org/docs/zuul/latest/gating.html)
- Gerrit topics: with `config.submitWholeTopic` enabled, submitting one change submits all changes in the topic. "Topics that span only a single repository are guaranteed to be submitted together." "Topics that span multiple repositories simply triggers submission of all changes. No other guarantees are given." "Submission of all changes could fail, so you could get a partial topic submission." Topics are not namespaced and work within one Gerrit instance only. Android's `repo upload -o topic=NAME` sets the topic. Opened — [Gerrit: Cross-repository changes](https://gerrit-review.googlesource.com/Documentation/cross-repository-changes.html)
- multi-gitter runs one script across many repositories and opens a PR in each; the set of PRs is identified by a shared branch name (`-B/--branch`), and `merge`, `status` and `close` act on "pull requests with a specified branch name in an organization." Platforms: github, gitlab, gitea, bitbucket_server, bitbucket_cloud (beta), gerrit. It has no ordering or dependency handling between repos; `pr-auto-merge` merges each PR when its own checks pass. Opened — [lindell/multi-gitter](https://github.com/lindell/multi-gitter)
- Signadot links the PRs of one feature across repos with a shared label (`epic`) set by a PR comment, and builds a combined preview from it. — [Signadot blog](https://signadot.com/blog/collaborative-pre-merge-testing-for-multi-pr-features)
- Each Parallel Change phase can be released on its own, which is what makes non-atomic, ordered merges safe. — [martinfowler.com: ParallelChange](https://martinfowler.com/bliki/ParallelChange.html)

### Inferences
- multi-gitter (and tools of the same class) fit the same mechanical change applied to many repos (a library bump, a config rename). A business feature is a different change per repo, so the useful parts to borrow are the conventions: one shared branch name per feature in every repo and status/merge commands keyed on that name.
- A lightweight convention for GitHub/GitLab without Zuul: same branch name in every repo (`feat/<feature-id>`); each PR description carries the feature id, links to sibling PRs, a `Depends-On:` line for each PR that must merge first, and the contract version; the orchestrator's ledger holds the merge order and merges in topological order, re-checking the gate before each merge.
- Rollback: because every step is additive, rollback is "revert or flag off in reverse order", and a consumer can be rolled back without touching the provider. A provider rollback after consumers are live is the dangerous case; the flag should therefore be the first rollback tool and the contract/cleanup phase should wait until the feature is confirmed in production.

### Gaps
- Sourcegraph Batch Changes was not opened this session (prior knowledge: declarative batch spec, changesets tracked across code hosts; like multi-gitter, aimed at uniform changes). Pointer: sourcegraph.com/docs/batch-changes.
- No source found on rollback strategy for multi-repo changes made by agents, on cross-repo CI triggers (GitHub `repository_dispatch`, GitLab multi-project pipelines), or on GitHub merge queue behaviour across repositories. Whether Zuul merges a dependency cycle atomically is not stated on the page opened.

## 8. Shared state for agents and the change-request protocol when the contract must change mid-flight

### Takeaway
Two coordination models appear in 2026 write-ups: orchestrator-only relay with a durable file ledger, and a shared task list with direct peer messaging. For contracts specifically, the evidence favours one frozen, versioned contract file plus a write path that goes through one owner: a static contract pasted at launch demonstrably drifts, and the only explicit advice on mid-flight change is to version the contract and re-dispatch the affected agents against the new version.

### Cited Findings
- Real-world report of the failure of static sharing (issue opened 2026-07-30, closed 2026-09-22): in a multi-repo task "each repo's worktree spawns its own separate agent session/chat" and "no session can see another session's output, decisions, or diffs." "Each agent independently interprets the Task description" and "any drift between their interpretations only surfaces at human review time." The workaround (contract in shared context) is a "static, one-way broadcast at launch" that "can't capture decisions an agent makes during its session", e.g. a renamed field never reaches sibling sessions. Proposed fixes, in order: sibling sessions can read each other's diffs/summaries; a "Task-scoped scratchpad that any session can write decisions to" so "contract changes propagate instead of drifting"; a task-level orchestrator. The maintainers shipped cross-directory visibility (v0.9.0), "not a full shared scratchpad or orchestrator session." Opened — [GitKraken issue 33: Task-level agent coordination for multi-repo Tasks](https://github.com/gitkraken/gk-ade/issues/33)
- Orchestrator-only relay: "They don't see each other's state, so the orchestrator passes along anything that needs to cross over." "Reconciliation is the orchestrator's job." "Managers hold the plan; workers execute, one repo, one task." Guardrails are structural: restrict tools "by removing their write tools, not by asking nicely." The article is design reasoning with a hypothetical example, not a production report; it also states "Subagents cannot spawn other subagents" for the tool it describes. Opened — [One Agent Per Repo, dev.to](https://dev.to/just_an_electron/one-agent-per-repo-an-orchestration-pattern-for-multi-repo-ai-coding-49ba)
- Peer messaging model: teammates "message each other directly - peer-to-peer, not through the lead"; example: the back-end agent sends the front-end agent the API contract. Shared task list with statuses and dependency unblocking; file locking; plan approval by the lead before coding; "Three to five teammates is the sweet spot." This conflicts with the orchestrator-only relay model above; the article does not say what happens when an interface changes mid-work. Opened, 2026-03-26 — [Addy Osmani: The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)
- Mid-flight contract change: breaking the contract mid-run requires re-dispatching both agents with the new version; "Version contracts explicitly." If the consumer needs producer internals, the contract is wrong and the seam should be redrawn. — [Contracts Parallelize Agents](https://understandingdata.com/posts/contracts-parallelize-agents/)
- A plain-file ledger design for multi-repo orchestration: the ledger (`ledger/tasks.json`, `ledger/sessions.json`, transcripts, heartbeats) is "the only shared state; everything is a plain file"; an "Overlap check before any dispatch" compares new requests with in-flight and contract-published work on endpoints, schemas, permissions and migrations ("Duplicates are rejected and redirected; partial overlaps are negotiated; the verdict is logged"); a `contract-check.sh` script verifies stated artifact paths. Weak evidence: the repository showed 0 stars and 2 commits; the README does not describe dependencies or ordering between repos, or contract-change escalation. Opened — [agent-orchestra README](https://github.com/hosssein125/agent-orchestra)
- A multi-agent setup with one directory per agent used a CONFLICTS file where agents flag contract changes to be picked up later. Snippet only — [Run 5 Claude Code Agents in Parallel, dev.to](https://dev.to/max_65b37b69a1411997053b3/run-5-claude-code-agents-in-parallel-and-ship-a-saas-mvp-in-2-days-5e63)
- A vendor guide describes a "living spec" ledger that updates as agents complete work and propagates requirement changes to all active agents. Snippet only — [Augment Code: How to Run a Multi-Agent Coding Workspace](https://www.augmentcode.com/guides/how-to-run-a-multi-agent-coding-workspace)

### Inferences
- Recommended shared state for a parent-child tree (synthesis; no source describes all of it together):
  - Contract file(s): versioned, single writer (the orchestrator or a contract-owner agent), read-only for implementers, enforced structurally (file permissions, a hook, or by keeping the file outside the worker's writable tree) in line with the "remove the write tools" lesson.
  - Task ledger: one file per feature with `{task id, repo, phase, depends_on, status, contract_version, branch, PR url, verification result}`; single writer is the orchestrator; workers report through their return message. The `contract_version` field per task is what lets the orchestrator see which work is stale after a contract change.
  - Decision log / change requests: append-only, so a decision made in one repo session (the "renamed field" case) reaches the others.
  - Issue tracker and PR descriptions as the human-visible mirror, not as the agents' primary medium.
- Proposed change-request protocol when an implementer finds the contract wrong or incomplete:
  1. Stop work on the affected part; do not adapt the implementation or the mock locally and do not edit the contract.
  2. Report to the parent a structured change request: contract clause, observed problem, proposed change, whether it is additive or breaking, what is already built.
  3. The request travels up to the contract owner (the orchestrator at the level that owns the contract; intermediate parents forward, they do not decide).
  4. The owner classifies it: clarification (no schema change; append to the decision log and notify), additive (minor version bump; notify affected repos, running work continues and picks up the delta), breaking (new version; pause affected tasks, re-run schema diff, regenerate types and mocks, re-dispatch affected agents with the new version and a description of the delta).
  5. The ledger marks every task built against an older contract version as needing re-verification; the verifier re-runs the affected checks.
- Peer messaging (Osmani's model) shortens the path but leaves no single place that knows the current contract, which is the drift mechanism the GitKraken issue describes. For a tree of any depth, routing contract changes through the owner and letting peers exchange only questions is the safer default.
- Regenerated mocks and types act as an automatic notification: after a contract bump, the consumer's type-check and the provider's conformance tests fail exactly where the delta is.

### Gaps
- No source describes how to re-validate in-flight work after a contract change, or reports how often contracts change mid-flight in agent runs. The protocol above is an inference from the cited failure reports and the single explicit recommendation (version and re-dispatch).
- No source found on locking or concurrent writes to a shared ledger across worktrees beyond the "single shared state in plain files" claim of a low-adoption project.

## 9. Documented failure modes and mitigations

### Takeaway
The failure modes named in the brief are all documented, most with a qualitative report and a tool-level mitigation; none has a measured frequency for agent workflows. The best-evidenced ones are divergent interpretation across repo sessions and per-PR tests passing while the combined feature fails.

### Cited Findings
- Divergent interpretation: "Each agent independently interprets the Task description" and drift "only surfaces at human review time"; "the human ends up doing the integration reasoning." — [GitKraken issue 33](https://github.com/gitkraken/gk-ade/issues/33)
- Under-specified contract: one agent "assumes a field exists and the other never emits it." Mitigation: over-specify early, version explicitly. — [Contracts Parallelize Agents](https://understandingdata.com/posts/contracts-parallelize-agents/)
- Integration discovered at the end: a contract mismatch between PRs passes both per-PR checks and fails after merge. Mitigation: a combined pre-merge environment for all PRs of the feature. — [Signadot blog](https://signadot.com/blog/collaborative-pre-merge-testing-for-multi-pr-features)
- Spec-implementation drift: "If the OAS drifts from the implementation, BDCT will miss it." Mitigation: conformance checks of the running provider against the spec. — [Augment Code guide](https://www.augmentcode.com/guides/api-contract-testing-agent-authored-specs); [Prism proxy](https://github.com/stoplightio/prism)
- Tests that confirm bugs: generated tests may be "just testing the bugs as opposed to finding the bugs." Mitigation: human-in-the-loop review of generated contracts. — [TestGuild ep. 198, 2025-08-07](https://testguild.com/podcast/p198-matt/)
- Hidden coupling through a shared database: a developer "will need to coordinate schema changes with the developers of other services" (development-time coupling) and "all services access the same database they can potentially interfere with one another" (runtime coupling). Alternative: database per service. Opened; pattern page is old and still current — [microservices.io: Shared database](https://microservices.io/patterns/data/shared-database.html)
- Hidden coupling through shared libraries in micro-front-ends: singleton version skew and shared-library API changes fail at runtime. Mitigation: `strictVersion` / `requiredVersion`, contract tests of exposed modules. Snippet only — [Angular Architects](https://www.angulararchitects.io/blog/getting-out-of-version-mismatch-hell-with-module-federation); [The Micro-Frontend Chaos](https://itnext.io/the-micro-frontend-chaos-and-how-to-solve-it-960b0a90c58)
- Non-atomic cross-repo merge: "you could get a partial topic submission." Mitigation: make each change independently safe (Parallel Change). — [Gerrit docs](https://gerrit-review.googlesource.com/Documentation/cross-repository-changes.html); [ParallelChange](https://martinfowler.com/bliki/ParallelChange.html)
- Skipped cleanup: if the contract phase is not done, "you may end up in a worse state than you started." — [ParallelChange](https://martinfowler.com/bliki/ParallelChange.html)
- Agent-specific: agents loop on a broken approach (suggested cap `MAX_ITERATIONS=8`), miss constraints outside their context, and a flaky shared environment hits all agents at once. — [Addy Osmani](https://addyosmani.com/blog/code-agent-orchestra/)

### Inferences
- Mapping of failure mode to the cheapest gate that catches it:

| Failure mode | Gate | When |
|---|---|---|
| Contract change breaks existing consumers | `oasdiff breaking` / `buf breaking` on the frozen contract | Before dispatch |
| Consumer uses a field the provider does not emit | Generated types; consumer pact or mock-vs-spec comparison | During wave 1 |
| Provider differs from spec | Prism proxy / Schemathesis / Dredd against the provider branch | End of provider task |
| Two sides read the same spec differently | Named examples in the contract; combined environment E2E | Early skeleton run, then wave 2 |
| MFE exposed-module signature change | Host type-check against remote `@mf-types` | During wave 1 |
| Shared dependency skew | `strictVersion` and a range-comparison script | Wave 2 |
| Shared database coupling | A "tables touched" list per task in the plan; migrations as explicit DAG nodes | Planning |
| Wrong merge order | `can-i-deploy` or ordered merge from the ledger | Wave 3 |
| Old interface never removed | Cleanup task created in the ledger at planning time | After release |

- A shared database is a contract that no API diff tool sees. If two services of the feature read the same tables, the plan must treat the table schema as a contract with an owner, or the coupling stays invisible to every per-repo agent.

### Gaps
- No quantitative data on how often each failure mode occurs with AI implementers, and no controlled comparison of contract-first versus sequential (provider first, then consumer) agent workflows.
- Evidence for the agent-specific mitigations is anecdotal (single-author posts, one issue thread, vendor guides).
