<!--
Sync Impact Report
- Version change: N/A → 1.0.0
- Modified principles: New (I–IV established)
- Added sections: "Quality Gates & Tooling", "Development Workflow & Review Process"
- Removed sections: None (template placeholders replaced)
- Templates requiring updates:
  - ✅ .specify/templates/plan-template.md (Constitution Check gates aligned)
  - ✅ .specify/templates/spec-template.md (Added Non-Functional Requirements section)
  - ✅ .specify/templates/tasks-template.md (Tests marked REQUIRED; terminology aligned)
- Follow-up TODOs: None
-->

# Course Content Monitor (CCM) Constitution

## Core Principles

### I. Code Quality & Maintainability

Non-negotiable rules:

- Code MUST pass automated linting and formatting on every commit and PR.
- Complexity MUST be contained: small, cohesive modules; functions ≤ ~50 LOC unless justified.
- Public APIs and modules MUST include clear JSDoc/TSDoc types and usage examples.
- Changes MUST include refactoring when technical debt is touched (“boy scout rule”).
- Dependencies MUST be minimal and justified; avoid heavy libraries when native/web APIs suffice.

Rationale: Consistently readable, well-structured code reduces defects, accelerates onboarding,
lowers maintenance cost, and enables safe iteration over time.

### II. Testing Discipline & Coverage

Non-negotiable rules:

- Tests MUST be written for new/changed behavior before or alongside implementation.
- The test pyramid MUST be respected: fast unit tests first; integration for critical flows;
  end-to-end only when necessary.
- All CI MUST run tests on every PR; coverage for changed lines MUST be ≥ 80% and overall
  project coverage SHOULD be ≥ 70%.
- Flaky tests are NOT allowed in main; any flake MUST be quarantined and fixed within 48h.
- Test artifacts MUST be deterministic and hermetic (no external network without explicit mocks).

Rationale: A reliable, fast test suite is the primary safety net for refactors, performance work,
and rapid delivery without regressions.

### III. UX Consistency & Accessibility

Non-negotiable rules:

- User-visible changes MUST follow a consistent design system (components, spacing, colors,
  states) and copy guidelines.
- Accessibility MUST meet WCAG 2.1 AA intents for keyboard navigation, contrast, focus
  management, and semantics.
- Interaction states (loading, error, empty) MUST be explicit and non-blocking; no spinner-only
  dead-ends.
- Content and settings MUST persist and recover gracefully across extension reloads when applicable.
- UX changes MUST include screenshots or short clips in PRs when UI is affected.

Rationale: Predictable, accessible interfaces improve efficiency and trust for all users and
reduce support burden.

### IV. Performance & Reliability

Non-negotiable rules:

- UI MUST remain responsive: no long tasks on the main thread; offload work to background/
  workers where possible.
- Budgets MUST be defined and honored per feature:
  - Popup initial render ≤ 200ms on a mid-range laptop.
  - Long operations MUST stream progress; background checks MUST have concurrency limits.
- p95 operation times MUST be tracked in dev for critical paths; regressions ≥ 20% require
  explicit justification and follow-up issues.
- Network calls MUST have timeouts and retries with backoff; failures MUST surface actionable
  messages.
- Bundle size growth MUST be monitored; additions ≥ 50KB gzip require justification and
  alternatives considered.

Rationale: Fast, resilient behavior keeps the extension usable at scale and prevents lockups or
excess resource use.

## Quality Gates & Tooling

- CI MUST enforce: lint + format, type checks (via JSDoc/TS where applicable), tests, and
  coverage thresholds.
- Pre-commit hooks MUST run lint and minimal tests on staged files.
- Performance budgets and UX acceptance criteria MUST be specified in plan/spec for any
  user-visible feature.
- Observability for development (structured console logs, debug toggles) MUST be present to
  diagnose issues without production data leakage.

## Development Workflow & Review Process

- Every PR MUST:
  - Link to a spec/plan item defining acceptance tests, UX impacts, and performance budgets.
  - Include before/after screenshots for UI changes and note accessibility checks.
  - Pass all CI gates; no bypassing on main branches.
- Reviews MUST verify alignment with the four core principles and request changes when violated.
- Release notes MUST summarize user-facing changes and any performance implications.

## Governance

- Authority: This constitution supersedes any ad-hoc practices for code quality, testing, UX, and
  performance in this repository.
- Amendments: Propose via PR updating this file with rationale and any template changes. Require
  reviewer approval. Provide migration or follow-up tasks if principles change materially.
- Versioning policy: Semantic versioning of this constitution
  - MAJOR: Backward-incompatible governance/principle removals or redefinitions
  - MINOR: New principle/section added or materially expanded guidance
  - PATCH: Clarifications/wording/typo fixes without changing intent
- Compliance: Enforced through CI gates and code review. Periodic audits each release cycle confirm
  adherence; violations MUST be tracked with issues and remediation owners.

**Version**: 1.0.0 | **Ratified**: 2026-05-31 | **Last Amended**: 2026-05-31
