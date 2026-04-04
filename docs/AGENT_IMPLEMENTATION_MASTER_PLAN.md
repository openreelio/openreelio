# Agent Implementation Master Plan

Updated: 2026-04-03

## Purpose

This document replaces the older "rewrite in progress" framing with a concrete stabilization and surface-enforcement plan for the current OpenReelio agent stack.

The plan is informed by:

- the current OpenReelio sidebar runtimes (`AgenticEngine` and `AgentLoop`)
- the retained legacy request-response path through `chat_with_ai`
- a comparative audit of `claw-code`, focusing on reusable runtime patterns instead of wholesale porting

## Current State

OpenReelio currently has three distinct AI surfaces:

1. Legacy/internal request-response path: older store-driven chat through `chat_with_ai`, with no current shipping React chat surface
2. Canonical AI sidebar runtime: `AgenticEngine` (Think -> Plan -> Act -> Observe)
3. Compatibility runtime: `AgentLoop` (stream -> tool -> loop) for internal verification and harness work

This is already a meaningful platform, but it is uneven in maturity:

- execution and tool coverage are strong
- persistence and observability are partially mature
- true restart/resume is modeled more than executed
- some future-facing abstractions are ahead of product usage

## What To Adopt From `claw-code`

`claw-code` is useful as a harness-engineering reference, not as a product template.

Patterns worth adopting:

- treat agent sessions as structured runtime state, not just chat history
- keep compaction as a first-class runtime concern
- centralize permission policy at execution time, not in ad hoc UI checks
- assemble prompts from reusable sections instead of hard-coded inline strings
- support project-local instructions and learned context in a disciplined way

## What Not To Adopt

The following are currently too broad for OpenReelio's product shape:

- full plugin marketplace and install/update lifecycle
- multi-transport MCP surface area beyond clear product needs
- shell-style pre/post tool hooks
- remote proxy and cloud-runtime plumbing unrelated to video editing workflows
- broad CLI-first operational surfaces copied from coding harnesses

## Findings

### P0: Trust and Clarity

- Recovery UI currently implies restart behavior that is stronger than the executable resume path.
- Documentation is stale around the active runtime split and linked planning artifacts.
- The fast loop had a lower-quality prompt assembly path than the default TPAO runtime.

### P1: Runtime Convergence

- `AgentLoop` and `AgenticEngine` should share more of the same prompt, policy, and persistence vocabulary.
- Trace artifacts should be linked to persisted run rows.
- Recovery labels should describe verified capabilities, not inferred metadata richness.

### P2: Scope Control

- Subagent definitions, checkpoint abstractions, and some session-kernel vocabulary are ahead of production usage.
- These surfaces should either be wired into real flows or marked explicitly experimental/internal.

## Immediate Changes In This Pass

This pass focuses on safe, high-leverage improvements:

- unify `AgentLoop` system prompt assembly with the shared prompt builder
- inject learned context (recent operations, preferences, corrections) into the fast runtime prompt
- downgrade restart/resume wording to recovery wording where a true resume executor is not yet present
- repair stale roadmap/documentation references and lock the shipping sidebar to the canonical runtime

## Priority Roadmap

### Phase 1: Stabilize The Current Product Surface

- keep `AgenticEngine` as the shipping sidebar runtime
- keep `AgentLoop` compatibility-only until a dedicated debug surface is justified
- keep the legacy `chat_with_ai` path internal until a real product entry point exists
- ensure all user-visible recovery copy reflects real behavior

### Phase 2: Make Recovery Real

- implement an executable resume bootstrap path that consumes persisted checkpoint payloads
- validate restart continuation from checkpoint, summary boundary, and conversation-log replay paths
- add at least one integration-grade recovery test that exercises persisted artifacts across a fresh runtime/store bootstrap

### Phase 3: Tighten Observability

- allocate trace IDs before persisted run creation
- link trace IDs into run/session records
- expose run-to-trace correlation in developer diagnostics and support tooling

### Phase 4: Reduce Architectural Debt

- mark unused subagent and checkpoint abstractions as experimental until they are operational
- trim or quarantine platform surfaces that are not part of the shipping product path
- keep the session kernel vocabulary aligned with actually executable flows

## Acceptance Criteria

The agent system should be considered stable when all of the following are true:

- the runtime split is accurately documented
- the shipping sidebar exposes only the canonical runtime
- legacy and compatibility surfaces are clearly classified
- prompt quality is consistent across sidebar runtimes
- recovery wording matches verified capabilities
- persisted traces can be correlated to persisted runs
- at least one restart/resume path is executable and tested end-to-end

## Guiding Principle

OpenReelio should borrow harness ideas from coding agents only when they improve a video-editing product:

- more reliable execution
- clearer user trust boundaries
- better recovery
- better observability

Anything beyond that is platform vanity and should stay out until it earns its keep.
