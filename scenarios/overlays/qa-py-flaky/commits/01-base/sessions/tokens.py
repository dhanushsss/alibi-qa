"""Session tokens with a one-shot on-disk cache."""
import secrets
from pathlib import Path

CACHE = Path(".session-cache")


def format_token(raw: bytes) -> str:
    return raw.hex()


def issue_token() -> str:
    # A cached token is handed out once, then the cache is cleared.
    if CACHE.exists():
        token = CACHE.read_text().strip()
        CACHE.unlink()
        return token
    token = format_token(secrets.token_bytes(16))
    CACHE.write_text(token)
    return token
