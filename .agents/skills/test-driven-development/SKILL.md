---
name: test-driven-development
description: "Use when implementing features, bug fixes, refactors, or behavior changes. Executes test-first development in coherent reviewable batches: brief the user on the batch goal and every planned test case, wait for explicit approval, establish the complete batch RED suite, implement the whole batch to GREEN, then verify and hand off at the batch boundary."
---

# Batch-Oriented Test-Driven Development

## Core Rule

```text
NO BATCH IMPLEMENTATION BEFORE THE BATCH'S BEHAVIOR TESTS
HAVE BEEN WRITTEN AND OBSERVED FAILING FOR THE EXPECTED REASONS
```

The Batch is the unit of development, verification, review, and suggested commit history.
Individual tests and RED/GREEN transitions are internal work inside that Batch. Do not pause,
request review, or create commits for each test unless the user explicitly asks.

Before every Batch, present its goal and complete planned test-case inventory to the user. Do not
write tests or production code until the user explicitly approves that Batch.

## What Counts as a Batch

A Batch is a coherent behavior slice from an approved implementation plan. It may cross files or
packages when the contract and its consumers must change together. It must:

- Deliver one reviewable capability or architectural boundary.
- Include all tests and production changes required to leave the repository GREEN.
- Avoid unrelated cleanup or behavior assigned to later Batches.
- End with a clear observable result and verification evidence.

If no approved plan defines the Batch, state the proposed scope and acceptance behavior before
editing. Ask only when different Batch boundaries would materially change the implementation.

## Batch Workflow

### 1. Brief and Approve the Batch

Before editing tests or production code:

1. Read the relevant design, implementation plan, source, and existing tests.
2. Confirm that required upstream contracts are available.
3. Identify design gaps that would change public APIs, persistence, ordering, or error semantics.
4. Present a Batch briefing containing:
   - Goal: the user-visible or architectural outcome.
   - Scope: likely modules/files, important boundaries, and explicit non-goals.
   - Completion standard: acceptance behavior and verification commands.
   - Test inventory: every test case planned for the Batch, including new and materially changed
     cases. For each case, state its scenario or precondition, relevant input/action, expected
     observable result, and the contract or risk it proves.
5. Ask the user to approve the Batch and wait for an explicit confirmation.

Read-only discovery is allowed before approval. Writing or modifying tests, fixtures, production
code, generated implementation artifacts, or commits is not allowed.

Do not invent missing architecture inside implementation. Pause for a design decision when such a
gap exists.

If implementation later reveals a required test scenario that was not in the approved inventory,
pause before adding it. Present the test delta and any scope impact, then wait for explicit user
approval. Mechanical renames or assertion wording changes that do not alter the approved scenario
do not require a second approval.

### 2. RED: Build the Batch Test Set

Write or update the complete set of tests needed to prove the Batch's acceptance behavior before
changing production code for that Batch.

The RED test set must match the user-approved inventory.

Requirements:

- Cover normal behavior, important boundaries, and errors included in the Batch.
- Prefer observable behavior and real collaborators; use mocks only at genuine external
  boundaries.
- Keep each test focused, but allow multiple related assertions when together they express one
  contract.
- Put a concise comment immediately above every `test(...)` or `it(...)` explaining the
  scenario and expected observable result.
- Do not add tests for later Batches merely because nearby code is being touched.

Run the Batch test set and inspect the result:

- The new behavior must fail for the expected missing or incorrect behavior.
- A missing public contract may produce an expected compile/type failure during RED.
- Environment, import, syntax, fixture, or test-runner failures are not valid RED; fix the test
  setup first.
- If a test passes because the behavior already exists, verify that it truly proves the
  requirement. Keep it as regression coverage if useful, but ensure every production behavior
  change in the Batch is motivated by at least one observed failure.

The RED gate applies to the Batch as a whole. It is not necessary to run, review, or hand off each
test separately.

### 3. GREEN: Implement the Complete Batch

After the Batch RED set is valid, implement all production behavior required by that Batch.

- Work continuously across the Batch; do not stop after making the first test pass.
- Make the smallest coherent implementation that satisfies the complete Batch contract.
- Do not implement speculative options, later-Batch features, or unrelated refactors.
- Keep public API changes and all required consumers in the same Batch so the repository can end
  GREEN.
- Re-run targeted tests as needed while implementing, but treat intermediate partial GREEN states
  as internal progress rather than review boundaries.
- Put a concise responsibility comment immediately above every production function, class method,
  constructor with non-obvious setup, or function-valued variable introduced or changed in the
  Batch. Explain important boundaries or side effects without narrating the code.

If production code for the current Batch was written before its RED set, revert those production
edits and restart the Batch from tests. Do not delete unrelated pre-existing code.

### 4. REFACTOR: Clean Up Within the Batch

Only after the Batch test set is GREEN:

- Remove duplication introduced by the Batch.
- Improve names and extract helpers where they clarify the implemented boundary.
- Keep behavior and tests stable.
- Do not use refactoring as a reason to absorb unrelated work.

For a pure behavior-preserving refactor Batch, establish a GREEN characterization baseline first,
then refactor while continuously preserving it. The RED requirement applies to new or changed
observable behavior, not to a refactor whose contract intentionally remains unchanged.

### 5. Verify the Batch

Before declaring the Batch complete:

1. Run the Batch's targeted tests.
2. Run impacted regression tests.
3. Run the plan-required typecheck, lint, formatting, build, and broader tests.
4. Confirm output contains no unexplained errors or warnings.
5. Review the diff for scope drift, test-only production APIs, accidental public exports, and
   changes belonging to later Batches.

Never commit or hand off a RED repository.

### 6. Hand Off at the Batch Boundary

Report:

- The capability completed.
- The main files or modules changed.
- RED evidence observed before implementation.
- GREEN and regression commands executed.
- Any design deviation, residual risk, or deferred work.

Pause for review after the Batch by default. If the user explicitly authorizes continuous
multi-Batch execution, still complete and verify each Batch independently before starting the next
one.

A Batch is a suggested commit boundary, but execute `git commit` only when the user explicitly
authorizes it.

## Bugs and Regressions

For a bug-fix Batch:

1. Add the complete regression test set that reproduces the bug and relevant edge cases.
2. Observe the expected RED result.
3. Implement the fix across the Batch.
4. Verify the new regression tests and impacted existing tests are GREEN.

Never fix a bug first and add the regression test afterward.

## Test Quality

- Test behavior, not private implementation details.
- Prefer real code over mocks; mock only boundaries that are slow, nondeterministic, destructive,
  or external.
- Do not assert that a mock merely exists or was configured.
- Do not add production methods used only by tests.
- Use controllable promises, barriers, fake clocks, or deterministic fakes for concurrency; do not
  depend on timing sleeps.
- Read [testing-anti-patterns.md](./testing-anti-patterns.md) before adding mocks, test utilities,
  or test-only seams.

## Comment Quality

### Tests

Comments above test cases must explain the setup or input, the behavior exercised, and the expected
observable result. Do not merely repeat the test name.

### Production

Responsibility comments must explain what the function or method does and mention important side
effects or boundaries when relevant. Do not translate the symbol name or narrate individual
statements.

## Stop Conditions

Stop the Batch and ask for direction when:

- The user has not explicitly approved the Batch briefing and test inventory.
- The approved design cannot express a required public contract or durable boundary.
- A required upstream Batch is missing or incompatible.
- Passing the tests would require materially expanding the agreed Batch.
- A required test scenario was not included in the approved inventory.
- Existing user changes overlap in a way that cannot be preserved safely.

Do not stop merely because the Batch contains multiple tests, files, or packages. That is expected.

## Batch Completion Checklist

- [ ] Batch scope and acceptance behavior were established before editing.
- [ ] The Batch goal, completion standard, and every planned test case were explained to the user.
- [ ] The user explicitly approved the Batch before any test or production edit.
- [ ] The implemented RED test set matches the approved inventory or an approved test delta.
- [ ] The complete Batch test set was written before production changes.
- [ ] New or changed behavior was observed failing for the expected reason.
- [ ] Production changes stayed within the Batch.
- [ ] Tests and production code land together.
- [ ] Test and production responsibility comments meet project rules.
- [ ] Targeted and impacted regression tests pass.
- [ ] Required typecheck, lint, formatting, and build checks pass.
- [ ] The repository is GREEN at the Batch boundary.
- [ ] The handoff reports evidence, risks, and deferred work.

## Final Rule

```text
Batch scope
  → explain goal and every planned test case
  → explicit user approval
  → complete Batch RED test set
  → verify expected failures
  → implement the complete Batch
  → GREEN
  → refactor
  → full Batch verification
  → review / authorized commit
```
