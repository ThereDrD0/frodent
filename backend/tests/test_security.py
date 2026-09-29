import pytest

from ryadom_backend.security import access_token, decode_access_token, hash_password, new_refresh_token, token_hash, verify_password


def test_password_hash_is_salted_and_verifiable():
    first = hash_password("very long password")
    second = hash_password("very long password")
    assert first != second
    assert verify_password("very long password", first)
    assert not verify_password("wrong password", first)
    assert not verify_password("very long password", "not-a-password-hash")


def test_access_token_signature_expiry_and_claims(monkeypatch):
    monkeypatch.setattr("ryadom_backend.security.time.time", lambda: 1_800_000_000)
    token, expiry = access_token("a" * 40, "6d147210-458f-4b3e-98e7-e834134f2995", 4, 15)
    assert expiry == 1_800_000_900
    assert decode_access_token("a" * 40, token)["ver"] == 4
    with pytest.raises(ValueError):
        decode_access_token("b" * 40, token)
    monkeypatch.setattr("ryadom_backend.security.time.time", lambda: expiry + 1)
    with pytest.raises(ValueError):
        decode_access_token("a" * 40, token)


def test_refresh_tokens_are_opaque_and_hashed():
    raw, digest = new_refresh_token()
    assert len(raw) >= 60
    assert digest == token_hash(raw)
    assert raw != digest
