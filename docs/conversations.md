# Persistent conversation history (0.5.0)

Status: **implemented and tested** (13 tests, real SQLite round-trip). Schema v6.

## What is stored

| Table | Columns |
|---|---|
| `conversations` | id, profile_id, title, archived, pinned, created_at, updated_at |
| `conversation_messages` | id, conversation_id (FK, cascade), role, content, provider_label, model, created_at |

Both are additive; a v5 database upgrades in place and existing facts, stories,
meetings and practice sessions are untouched (`tests/conversations.test.ts` covers the
v5 → v6 upgrade).

## Behaviour

- **Automatic save.** A conversation is created on the first message and every user/assistant
  message is appended. An assistant message is stored only when generation finished, so a
  cancelled or failed reply never becomes history.
- **Titles without extra inference.** The title is the first user message (single line, ≤ 80
  chars, ellipsised). This is deliberate: naming a chat must not depend on a provider being up,
  and the brief forbids duplicate inference. Renaming is one click.
- **Search** matches the title *or* any message body, so "the thing I asked last week" is findable.
- **Pin** keeps a conversation at the top; **archive** hides it until the archive toggle is on;
  **delete** asks for a second click and removes messages with the conversation (FK cascade).
- **Continue** any conversation by opening it from history — the last 12 messages are sent as
  context, the full transcript stays stored.
- **Profile isolation.** Every read and write is scoped to the active profile; opening another
  profile's conversation returns nothing and writes are refused.
- Works identically in local, cloud and hybrid modes — persistence never calls a model.

## Not implemented

- Export of a conversation to a file (the transcript is visible and copyable per message).
- Cross-profile conversation sharing (intentional).
- Full-text indexing: search uses `LIKE` over title and message bodies, adequate at desktop scale.
