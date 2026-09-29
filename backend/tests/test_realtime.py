import asyncio
from datetime import datetime, timedelta, timezone

from ryadom_backend.realtime import RealtimeHub, valid_ephemeral


def test_ticket_is_single_use_board_scoped_and_expiring():
    async def scenario():
        hub = RealtimeHub()
        ticket, _ = hub.issue_ticket("board-one", "user-one")
        assert await hub.consume_ticket(ticket, "board-two") is None
        assert await hub.consume_ticket(ticket, "board-one") == "user-one"
        assert await hub.consume_ticket(ticket, "board-one") is None
        expired, _ = hub.issue_ticket("board-one", "user-one")
        board, user, _ = hub.tickets[expired]
        hub.tickets[expired] = (board, user, datetime.now(timezone.utc) - timedelta(seconds=1))
        assert await hub.consume_ticket(expired, "board-one") is None
    asyncio.run(scenario())


def test_ephemeral_event_shapes_are_bounded_and_server_identity_cannot_be_spoofed():
    assert valid_ephemeral({"type": "cursor", "x": 1, "y": -4})
    assert not valid_ephemeral({"type": "cursor", "x": 1, "y": 2, "userId": "admin"})
    assert not valid_ephemeral({"type": "cursor", "x": float("inf"), "y": 0})
    assert valid_ephemeral({"type": "selection", "objectId": "6d147210-458f-4b3e-98e7-e834134f2995"})
    assert not valid_ephemeral({"type": "selection", "objectId": "not-a-uuid"})
    assert valid_ephemeral({"type": "stroke-preview", "points": [[0, 0], [10, 10]]})
    assert not valid_ephemeral({"type": "stroke-preview", "points": [[0, 0]] * 201})
    assert valid_ephemeral({"type": "leave"})
