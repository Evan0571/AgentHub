# Agent Runtime Optimization Plan

This document records the next AgentHub runtime improvements learned from the
reference AgentHub codebase and maps them into the current Web + NestJS
architecture.

## Goal

Move AgentHub from "multi-agent chat with workspace tools" toward a real
workspace-first agent runtime:

- agents ask users concrete questions when ambiguity changes product shape
- users can see whether an agent is running, blocked, waiting for input, or idle
- team members coordinate through a shared task board instead of prose only
- agents can send directed messages to teammates and preserve handoff context
- shell, Docker, filesystem, and external-service work is governed by policy
- project, team, and per-agent memory are loaded and updated deliberately

## P0: Structured User Questions

Current problem: clarification is emitted as ordinary text, so the UI cannot
distinguish "agent is waiting for the user" from "agent finished a paragraph".

Target behavior:

- server emits an `ask_user_question` event with 1-4 concrete questions
- each question has 2-4 choices, an optional recommended choice, and optional
  free-text notes
- UI renders a focused question panel near the composer
- answering the question resumes the coordinator with the original goal plus
  the selected answers
- agent state is set to `waiting_user` while the question is pending

Initial files:

- `packages/shared-types/src/ws-protocol.ts`
- `apps/server/src/conversation/mention-router.ts`
- `apps/server/src/conversation/conversation.gateway.ts`
- `apps/web/lib/store.ts`
- `apps/web/components/chat/ChatPane.tsx`

## P0: Runtime State Visibility

Current problem: users can see some thinking/tool output, but not the agent's
runtime state. A quiet stream looks like a hang.

Target behavior:

- server emits `agent_state` events for `running`, `waiting_user`, `blocked`,
  `idle`, and `failed`
- message rows show the current state and last state reason
- Activity / Team panels include waiting and blocked counts
- watchdog failures surface as `blocked` or `failed`, never silent spinner-only
  states

## P0: Team Task Board

Current problem: Plan DAG exists, but agents cannot coordinate by claiming,
blocking, or updating work as a team-owned task board.

Target behavior:

- task records have owner, blockedBy, blocks, activeForm, status, and handoff
  notes
- agents can list, claim, update, block, and complete tasks through tool calls
- every task completion has a verifiable result or a specific blocker
- Team panel shows member ownership and unblocked work queue

## P1: Directed Agent Messages

Current problem: group chat and `@` mentions are useful, but there is no explicit
teammate mailbox protocol.

Target behavior:

- agent output is not assumed to be visible to other agents unless explicitly
  sent
- agents send directed messages by teammate name, not internal UUID
- messages are delivered automatically and queued while the receiver is running
- peer DMs can be summarized in the team lead view without flooding context

Implemented foundation:

- `team_message_send` writes directed handoff messages to
  `.agenthub/TEAM_MAILBOX.json`
- `team_message_list` reads unread messages for the current agent by default
- `team_message_mark_read` marks consumed handoffs as read
- the tool runner injects the current agent id/name into mailbox and memory
  calls so agents do not need to know internal UUIDs
- Team panel reads `.agenthub/TEAM_MAILBOX.json` and shows recent directed
  handoffs in a mailbox section
- `team_message_send` also creates a scheduler-facing item in
  `.agenthub/TEAM_WAKE_QUEUE.json`
- `team_wake_list` and `team_wake_update` let agents inspect, claim, resolve,
  or cancel wake requests
- `TeamWakeService` scans pending wake requests after group-chat agent runs and
  plan-task agent runs, claims the target teammate, invokes that agent with the
  directed handoff, then marks the mailbox message read and the wake request
  resolved
- wake requests now track `attempts`, `maxAttempts`, `nextRunAt`, `lastError`,
  and `failed` state so failed teammate invocations can retry instead of
  disappearing
- wake scheduling skips teammates that are already being invoked in the same
  conversation
- Workspace API exposes wake queue list, requeue, and cancel endpoints
- Team panel shows wake queue state, retry errors, attempt counts, and manual
  requeue/cancel controls
- wake scheduling recovers stale `claimed` requests after a timeout so a crashed
  or interrupted teammate run does not permanently block the handoff
- wake queue listing is ordered by active status, retry time, priority, and age

Remaining depth:

- richer scheduling policy: priority fairness across long queues and history
  analytics for repeated teammate handoff failures

## P1: Permission And Infrastructure Policy

Current problem: workspace tools can write files and run terminal commands, but
high-risk operations need stronger guardrails.

Target behavior:

- classify shell commands into read-only, normal write, destructive, network,
  Docker, and credential-sensitive groups
- require confirmation for dangerous filesystem, Docker, credential, and
  deployment actions
- show exact command, cwd, reason, and proposed persistence scope
- Docker/database work must run a non-long-running diagnostic such as
  `docker compose config`; if Docker is unavailable, report the real CLI/daemon
  error and setup step

Implemented foundation:

- `terminal_run` now classifies each command as `read_only`, `normal_write`,
  `network`, `docker`, `deployment`, `credential_sensitive`, or `destructive`
- destructive, deployment, and credential-sensitive commands are blocked with a
  concrete confirmation-required error instead of silently running
- Docker and network commands are allowed but surfaced as explicit risk classes
- blocked commands are written to `.agenthub/PERMISSIONS.json`
- Workspace API exposes permission list / approve / deny endpoints
- the right-side Permissions panel shows pending commands and lets the user
  approve or deny them; approved commands are single-use for the same command
  and cwd
- `.agenthub/PERMISSIONS.json` also stores persistent permission policies for
  exact command/cwd/risk approvals and limited cwd/risk approvals
- `terminal_run` checks enabled policies before requiring a fresh confirmation
- the Permissions panel can remember an exact command, remember a safe cwd/risk
  scope, and revoke saved rules
- cwd/risk persistence is blocked for destructive and credential-sensitive
  commands; those can only be persisted as exact command decisions

Remaining depth:

- optional policy expiry and audit summary for long-running projects

## P1: Layered Memory

Current problem: `PROJECT.md` and `TEAM_MEMORY.md` provide useful project/team
memory, but memory is not scoped per agent or retrieved by relevance.

Target behavior:

- project memory: stable product and architecture decisions
- team memory: shared handoffs, env contracts, schema/API contracts, blockers
- agent memory: role-specific learnings and repeated preferences
- local memory: machine-specific paths, installed tools, and setup caveats
- each substantial task reads relevant memory before work and updates memory
  only when a durable fact changes

Implemented foundation:

- `memory_context` reads project, team, current-agent, and local memory layers
- `memory_context` accepts a task/blocker `query` and returns ranked
  `highlights` with scope, file path, line range, score, and snippet text while
  preserving the full layered entries for compatibility
- `memory_note` appends durable facts to the selected memory layer
- agent memory is stored under `.agenthub/memory/agents/<agent>.md`
- local machine caveats are stored in `.agenthub/memory/LOCAL.md`
- workspace tool mode, plan-task execution, and teammate wake prompts now include
  a final memory review checkpoint: durable decisions/contracts/env/schema/Docker
  setup/handoffs/local caveats should be written with `memory_note` before the
  final response

Remaining depth:

- structured memory review summaries in the UI

## P1: Workspace UI Readability

Current problem: workspace/file UI can feel visually thin, file glyphs are not
distinct enough, and the editor must respect light mode without leaving a dark
code surface behind.

Implemented foundation:

- file glyphs use larger fixed dimensions, stronger color contrast, and inset
  rings so extensions/folders scan more like an IDE file tree
- workspace file rows use slightly larger medium-weight sans text instead of
  tiny mono labels for primary names
- Monaco editor uses explicit `agenthub-light` and `agenthub-dark` themes with
  fixed editor/gutter/minimap backgrounds
- code surfaces use slightly heavier mono text for readability
- global UI base weight is raised to reduce the thin-text feeling

Remaining depth:

- visual screenshot pass across light/dark mode after the dev server is running

## Execution Order

1. [done] Implement structured user questions and `waiting_user` state.
2. [done] Extend runtime state handling into message rows, Activity panel, and Team
   panel.
3. [done] Promote Plan tasks into an agent-readable task board.
4. [foundation done] Add directed teammate messages and wake scheduling.
5. [foundation done] Add permission policy for shell/filesystem/Docker/external-service actions.
6. [foundation done] Add scoped memory loaders and update rules.
7. [foundation done] Improve workspace file/editor readability.

## Validation

Each phase should pass:

- `pnpm --filter @agenthub/server typecheck`
- `pnpm --filter @agenthub/web typecheck`
- targeted manual smoke test for the affected WebSocket protocol
