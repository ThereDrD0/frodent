# WebSocket contract for the Ryadom Python API

All permanent mutations use `POST /api/v1/boards/{boardId}/operations`. WebSocket carries committed operation notifications and ephemeral state; it is never the source of durable state.

## Open a session

1. Send authenticated `POST /api/v1/boards/{boardId}/session`.
2. Connect to `GET /api/v1/boards/{boardId}/events?ticket=<one-time-ticket>` on the same origin. The ticket expires after 30 seconds, is single-use and is the only credential allowed in the URL. Do not put either access or refresh tokens in the URL.
3. The server sends `ready` with a session ID and connected participants. It subscribes the socket before this message.
4. Fetch the authenticated board snapshot. Drop buffered events with `serverSeq <= snapshot.serverSeq`, then apply later operation messages in ascending sequence order.
5. On reconnect, fetch `GET /api/v1/boards/{boardId}/operations?afterSeq=<last-seen-seq>` and repeat the same gap-free snapshot/event process if history is not sufficient.

Allowed Origin values are exact entries from `ALLOWED_ORIGINS`. Each board accepts up to ten active sessions. Access revocation and logout close matching sockets; the server rechecks membership every second. Tickets and ephemeral state live in the memory of the single API process.

## Server messages

| Event | JSON fields | Meaning |
| --- | --- | --- |
| `ready` | `sessionId`, `participants[]` | Subscription is active. Participant fields: `sessionId`, `userId`, `displayName`. |
| `operation` | `opId`, `serverSeq`, `object`, `actorId` | Durable operation, sent only after database commit. Object matches its HTTP ACK. |
| `board.updated` | `title` | Owner renamed the board. Object sequence does not change. |
| `presence.join` | `participant` | A live session joined. |
| `presence.leave` | `sessionId` | A session disconnected. |
| `member.removed` | `userId` | Owner removed an editor; that user's board sockets are closed. |
| ephemeral | `sessionId`, `userId`, `displayName`, client fields | Cursor/selection/drawing preview/editing state. Never persisted. |

## Client ephemeral messages

Allowed `type` values are `cursor`, `selection`, `stroke-preview`, `editing` and `leave`. Cursor and stroke coordinates must be finite and within ±1,000,000. Preview packets allow up to 200 points and 16 KiB. Selection/editing may contain an `objectId` UUID or null. The server adds the trusted session/user identity and drops more than one ephemeral packet per 20 ms per connection.

Permanent changes sent in a WebSocket frame are rejected. Use HTTP operations with `opId` idempotency and `baseRevision` instead. An HTTP 409 includes the complete current object when a revision or object state conflicts. Reconnect with the same operation ID and same normalized request to safely recover a lost HTTP acknowledgement.

## Close codes

| Code | Meaning |
| --- | --- |
| `4400` | Invalid JSON, oversized, or unsupported message. |
| `4401` | Missing, expired, reused, or invalid ticket/session. |
| `4403` | Origin or current board membership is no longer allowed. |
| `4429` | The board already has ten active sessions. |

The current frontend has not yet adopted this remote event contract; it continues to use IndexedDB and BroadcastChannel for board interaction.
