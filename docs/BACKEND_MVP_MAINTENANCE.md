# Backend MVP contract maintenance

## When to use

This file records maintenance decisions for an archived handoff. The production implementation is the standalone Python API under `backend/`; its deployed endpoints and current UI boundary are documented in `backend/README.md`. The existing editor remains local-first, so do not describe API support as full browser synchronization.

## Decisions

Use separate PostgreSQL board tables, HTTP object operations and WebSocket notifications in the Python service. A single API replica and persistent file volume are sufficient. Invite acceptance creates durable editor membership. Object revisions reject concurrent overwrites; character-level CRDT is outside MVP. PostgreSQL and uploaded originals, not IndexedDB, become authoritative for server snapshots.

## Review checklist

Keep snapshot/subscription ordering, idempotent retries, attachment durability, membership revocation and backup consistency explicit. Changes to limits or transport require corresponding frontend validation/proxy updates. Never promise remote collaboration based on mock tests. Test Docker restore against disposable volumes, never existing user data. Do not start services merely to review documentation.

## Review record — 2026-09-12

Compared the proposal with current UserController/NotesController declarations and frontend object/snapshot adapters. Clarified auth exceptions, response arrays/status codes, semantic request hashing, concurrent invitation revocation, outbound stroke message size and bounded WS queues on the second reading. Links are offline reference pointers, not online-verified citations. No backend/runtime files or system packages changed.
