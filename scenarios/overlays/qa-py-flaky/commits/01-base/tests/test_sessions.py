from sessions.tokens import CACHE, format_token, issue_token


def test_format_token_is_hex():
    assert format_token(b"\x00\xff") == "00ff"


def test_new_session_persists_its_token():
    token = issue_token()
    assert len(token) == 32
    assert CACHE.read_text().strip() == token
