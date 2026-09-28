# Operational Wiki pilot cutover result — 2026-09-28

## Decision

The three human-approved pilot matter documents were cut over from `legacy_db` to
`markdown` as the active Wiki source. The operational cutover and an isolated
recovery rehearsal both succeeded. No active Markdown document was modified and
all legacy database revisions were retained.

## Authorization and implementation

- Authorization: `wiki-pilot-human-approval-2026-09-28`
- Reviewer: `장진태`
- Gate implementation commit: `dfde283fbdbb9969ec891fb1e4b1d16011713090`
- Runtime profile: `operational`
- Migration: `019_wiki_document_approval_cutover.sql`
- Completed: `2026-09-28T08:10:06.480Z`

The gate required an exact operational authorization token, exact database,
Vault, and output-root paths, a clean implementation worktree, a matching
`wiki.document_approved` event and accepted `user_feedback`, and a fresh
evidence-snapshot hash for every target.

## Independent evaluation before cutover

- Eval run: `operational-cutover-dfde283-001`
- Runner manifest SHA-256:
  `53c54645691e7aec5dda72ba2ba01fa7116d4af596a2a50e2bbc273a7f6f039b`
- Grader result: **43/43 passed**
- Grader report SHA-256:
  `ff2323860f05780d56ba827b0437f823e9586824e073a30dc33b814ff22cfd93`
- All manifest and 11 artifact hashes matched.
- Four synthetic documents passed cutover, recovery, legacy-write blocking,
  and production-immutability checks.

## Production result

- Cutover run: `wiki-cutover-2e822b71a4e37c8082a5c28e`
- Cutover status: `succeeded`
- Recovery rehearsal: `wiki-recovery-4c5f507742337546bd9a2d88`
- Recovery status: `succeeded`
- Recovery verification SHA-256:
  `dfd355d6ed04208778e2186f519a399d7e8e2bebae029099065a493e985f5498`
- Active Markdown modified: `false`
- Legacy write after cutover: blocked
- SQLite integrity: `ok`
- SQLite foreign-key violations: `0`

| Matter | Active source | Approved/current SHA-256 | Legacy revisions retained |
| --- | --- | --- | ---: |
| `P261252` | `markdown` | `d11116fe7779ba0f46fb7960f6d14934f91792eb1d4f3927ffe53949c90e7a9d` | 1 |
| `P261016` | `markdown` | `90b29299d15fcf05c20271ccb3f674445c21b724e5988adc4602911344229856` | 2 |
| `P261687` | `markdown` | `7a475018c9cb669388493f9d5c18950fad60c60a67f06456a5b0e687705cb99a` | 3 |

## Recovery evidence

The recovery rehearsal restored the post-cutover database and the complete
Vault into an isolated recovery root. It verified all three document hashes,
their `markdown` source mode, approval events, evidence snapshots, and source
change events without modifying production.

The pre-cutover database backup is:

`C:\Users\donsh\AppData\Local\SSPAT\work-management\backups\sspat-work-pre-wiki-cutover-2026-09-28T08-09-30-335Z.db`

Its SHA-256 is:

`328628146d9322eb83c95be90a25c74f9e92119be175e52a252d9c9a5d6aab1a`

The immutable operation artifacts are under:

`C:\Users\donsh\AppData\Local\SSPAT\work-management\wiki-cutover\2026-09-28`

Key artifact hashes:

- Operational result: `04eee1ecd813b9639d5a6762f7233c6475a6a489cc11db86ef8dd5f93531d0e7`
- Cutover manifest: `3ee71fa4f53207f2abbde2fe45e50ab4b093f22a385353a5ae74e73780d8b64e`
- Recovery report: `2b2b9f63f86ed3685145e4d1c116c34f395fb10d3b4bd31dc4376e7a9d456222`

## Scope boundary

This operation changed only the Wiki source-mode records for the three approved
pilot matters and recorded cutover/recovery audit data. It did not execute
Outlook or EasyPAT mutations. Existing user changes in the application
repository and `.obsidian` settings in the Vault were preserved.
