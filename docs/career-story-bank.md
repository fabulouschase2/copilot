# Career Story Bank — Phase 2

Status: **implemented and verified** (drafting verified with a real local model).
Last verified: 2026-11-21.

## What it is

A per-profile bank of the user's own experiences, written in one of five answer
frameworks, reusable during interviews. The Interview view automatically attaches the most
relevant stories to a question.

| Framework | Fields shown |
|---|---|
| STAR | Situation · Task · Action · Result |
| CAR | Challenge · Action · Result |
| PAR | Problem · Action · Result |
| SOAR | Situation · Obstacle · Action · Result |
| Answer-first | Direct answer · Supporting evidence |

## Storage (schema v4)

A new **additive** table; no existing table is altered or dropped:

```sql
career_stories(
  story_id, profile_id, title, framework, situation, task, action, result,
  answer_first, skills_json, role, origin, created_at, updated_at
)
```

Migration rules followed from earlier phases: `CREATE TABLE IF NOT EXISTS`, index creation,
and `schema_version` bumped only after the table exists. A v2/v3 database upgrades in place;
`tests/sqlite-v3.test.ts` still proves no data loss, and `tests/stories-phase2.test.ts`
round-trips a story through a real SQLite file.

## Relevance is deterministic, not a black box

`rankStories(question, stories)` tokenizes both sides (stopwords removed), then weights:

- title match **3.0**
- skill match **2.5**
- body match **1.0**

normalized by `sqrt(question tokens) × 4`, clamped to `0..1`, then top 3 are kept. Every hit
carries a reason such as `matched skill "engineering", text "delivery"`. No match means no
story is attached — an unrelated question never drags in a random story.

## Drafting is grounded and never auto-saved

`draft()` sends the framework fields plus the **confirmed profile facts** and instructs the
model to use only those facts, leaving unsupported fields empty. The result fills the editor;
the user must review and press Save. The banner stays visible while the draft is unreviewed.

Measured with Ollama `qwen2.5:1.5b`, three facts (team of four, 40% build-time reduction,
12-service TypeScript migration):

```json
{"draftOk":true,"draftMs":17874,"providerLabel":"Ollama (self-test)",
 "draft":{"title":"Team Lead for Payment Platform Optimization",
  "situation":"I led a team of four engineers on a payments platform…",
  "task":"Reduce CI build times by 40 percent by caching dependencies and sharding tests.",
  "action":"Implemented caching of dependencies and sharding tests…",
  "result":"We successfully reduced CI build times by 40 percent…",
  "skills":["engineering leadership","optimization","team management","software architecture"]},
 "saveOk":true,"storedCount":1,
 "ranked":[{"sourceId":"story:story-selftest","score":0.505,
            "reason":"matched skill \"engineering\", text \"delivery\""}]}
```

**Observed limitation, stated plainly:** the 1.5B local model added “improved team
productivity” to the result — an inference not present in the facts. Larger cloud models are
usually more disciplined, but this is exactly why drafts are never saved automatically and
the editor asks the user to review every claim. Treat AI drafts as suggestions, not records.

## Interview integration

`ModesService` appends a `VERIFIED CAREER STORIES` block to the interview prompt, built from
the top-ranked stories for that question. The block labels the framework and every field, and
is introduced as material the user wrote — the fabrication prohibition still applies on top.

## Not done in this phase

- **DOCX résumé import** (PDF/TXT/MD are supported today).
- **Fact confirmation workflow** (confirm/reject/edit with source retention) — facts can be
  added and removed today, but there is no per-fact confirmation state.
- Multi-profile story sharing (stories are strictly per profile by design).
