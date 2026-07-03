---
name: brainstorming
description: "Use for Byte Mentor feature brainstorming, behavior changes, architecture decisions, or ambiguous implementation requests that need product/design clarification before coding. Guides a lightweight local design discussion, with optional notes in .agent/.design; do not create Jira tickets, Confluence pages, or heavy external specs."
---

# Brainstorming

Turn fuzzy ideas into clear, implementable decisions through short collaborative dialogue.

Start from the local project context, clarify only what is needed, propose options, and get user approval before implementation when the work is non-trivial or ambiguous.

## Scope

Use this skill for:

- New Byte Mentor features or meaningful behavior changes
- Memory, teaching-flow, agent, or data-model design decisions
- Requests with unclear user intent, success criteria, or product trade-offs
- UI/UX work where visual direction matters

Do not use this skill for tiny mechanical edits, direct bug fixes with clear acceptance criteria, or requests where the user explicitly asks to skip design.

This project does not use Jira, Confluence, or external product-doc workflows. Keep all outputs local and lightweight.

## Process

1. **Explore local context**
   - Read relevant files under the project, especially existing `.agent/.design` notes when they exist.
   - Check current implementation patterns before proposing changes.
   - Use recent commits only when they help explain current direction.

2. **Clarify the goal**
   - Ask one question at a time.
   - Prefer multiple-choice questions when the trade-off space is known.
   - Focus on purpose, constraints, success criteria, and what must stay out of scope.

3. **Keep scope small**
   - If the request spans multiple independent subsystems, stop and decompose it.
   - Help the user choose the first useful slice before designing details.

4. **Propose options**
   - Present 2-3 plausible approaches with trade-offs.
   - Lead with the recommended option and explain why it best fits the project.
   - Avoid over-engineering; choose the smallest design that still leaves clean extension points.

5. **Present the design**
   - Scale detail to risk: a few sentences for small changes, short sections for larger changes.
   - Cover architecture, data flow, behavior, edge cases, and tests only when relevant.
   - Ask for approval before moving from design discussion into implementation.

## Local Notes

Do not create Jira tickets, Confluence pages, or mandatory long-form specs.

Create or update a local design note only when the decision should survive the conversation, usually under:

```text
.agent/.design/<topic>.md
```

When writing a note, keep it concise:

- Context
- Decision
- Alternatives considered
- Open questions
- Implementation notes

Before finishing a note, check for TODO placeholders, contradictions, ambiguous requirements, and scope creep. Commit only when the user explicitly asks.

## Design Quality

- Prefer project conventions over new abstractions.
- Separate global product concepts from user-specific state.
- Keep units small enough to reason about and test independently.
- Improve unclear boundaries only when they directly affect the requested change.
- Do not propose unrelated refactors.

## Conversation Rules

- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present important decisions and get approval before implementation
- **Be flexible** - Go back and clarify when something doesn't make sense

## Visual Companion

A browser-based companion for showing mockups, diagrams, and visual options during brainstorming. Available as a tool — not a mode. Accepting the companion means it's available for questions that benefit from visual treatment; it does NOT mean every question goes through the browser.

**Offering the companion:** When you anticipate that upcoming questions will involve visual content (mockups, layouts, diagrams), offer it once for consent:
> "Some of what we're working on might be easier to explain if I can show it to you in a web browser. I can put together mockups, diagrams, comparisons, and other visuals as we go. This feature is still new and can be token-intensive. Want to try it? (Requires opening a local URL)"

**This offer MUST be its own message.** Do not combine it with clarifying questions, context summaries, or any other content. The message should contain ONLY the offer above and nothing else. Wait for the user's response before continuing. If they decline, proceed with text-only brainstorming.

**Per-question decision:** Even after the user accepts, decide FOR EACH QUESTION whether to use the browser or the terminal. The test: **would the user understand this better by seeing it than reading it?**

- **Use the browser** for content that IS visual — mockups, wireframes, layout comparisons, architecture diagrams, side-by-side visual designs
- **Use the terminal** for content that is text — requirements questions, conceptual choices, tradeoff lists, A/B/C/D text options, scope decisions

A question about a UI topic is not automatically a visual question. "What does personality mean in this context?" is a conceptual question — use the terminal. "Which wizard layout works better?" is a visual question — use the browser.

If they agree to the companion, read the detailed guide before proceeding:
`skills/brainstorming/visual-companion.md`
