---
name: cairn-tasks
description: Track multi-step or multi-session work as Cairn task notes (type task, status in frontmatter) so it survives context compaction and restarts - create, resume, update with checksums, find what's active or due. Use when work has 3+ steps or may outlast the conversation, or when the user asks to track a task.
---

# Tasks in Cairn

A task is a note with `type: task` in the `tasks/` folder. Status and progress live in the
**frontmatter**, which `search_notes filters=…` and `find_notes` query directly; no need to repeat them
as observations.

## Create

```
write_note title="Migrate billing to Stripe" directory="tasks" note_type="task" tags=["task"]
  metadata={"status": "active", "assigned_to": "claude", "current_step": 1, "priority": "high"}
  content="# Migrate billing to Stripe

## Steps
1. [ ] Export current plans from the old system
2. [ ] Create matching Stripe products
3. [ ] Switch the checkout page

## Observations
- [deadline] @due:2026-11-20 Checkout switched before the December invoices

## Context
What a smart person who knows nothing about this needs to resume: files and repos, decisions made
and why, what was tried, where related notes are.

## Relations
- part_of [[Billing]]"
```

Steps are concrete ("Create Stripe products for the 3 plans"), and the Context section is written
for someone resuming after memory loss. Context matters more than steps.

## Resume (session start, after compaction)

- Active tasks: `search_notes note_types=["task"] filters={"status": "active"}`.
- Mine: `filters={"assigned_to": "claude"}`; blocked: `{"status": "blocked"}`;
  several: `{"status": {"$in": ["active", "blocked"]}}`.
- Due this week: `search_notes note_types=["task"] time_kind="due" valid_overlaps="[2026-11-16,2026-11-23)"`
  (a day-precision due date counts from that day on, so overdue ones show too).
- With their fields: `find_notes filters={"status": "active"} fields=["current_step", "priority"]`.

Read the task, then continue from `current_step` using its Context.

## Update as you go

Read first (`read_note output_format=json` → `checksum`), then edit with `expected_checksum`; two
sessions often touch the same task, and `REVISION_CONFLICT` means the other one wrote first: re-read.

- Progress: `edit_note command=set_metadata metadata={"current_step": 3}`.
- Steps: `find_replace` `"2. [ ] Create"` → `"2. [x] Create"`, with a few words on the result.
- Context: `replace_section section="Context"` with the current state.
- Before a compaction or at the end of a session, flush every active task: step, checkboxes,
  context. What isn't written down is lost.

## Finish

`set_metadata metadata={"status": "done", "completed": "2026-11-20"}`, and a line on what was done
and any follow-up. Abandoned work: `"status": "abandoned"` with the reason. Don't leave finished
work `active`.

## Keeping tasks uniform (optional)

A schema note makes "complete task" checkable. Write `schema/Task.md` once:

```
---
title: Task
type: schema
entity: task
schema:
  status(enum): [active, blocked, done, abandoned]
  current_step?: integer
  assigned_to?: string
  parent_task?: Task
settings:
  validation: warn
---
```

Then `check_schema command=validate note_type=task` lists tasks with a missing or odd field, and
`command=diff` shows fields the tasks use that the schema doesn't name. In Cairn a frontmatter key
satisfies a field, so `status` needn't also be written as a `[status]` observation.

## Rules

- One task per unit of work; link subtasks with `- part_of [[Parent task]]`.
- The user's own task system (if they have one) stays theirs; this is for work you carry across
  sessions. Ask before creating tasks for the user.
- No receipt, not saved (see `cairn-notes`).
