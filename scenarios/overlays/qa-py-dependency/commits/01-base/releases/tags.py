"""Release tag ordering. Non-PEP 440 tags sort before every real version."""
from packaging.version import LegacyVersion, parse


def sort_tags(tags):
    return sorted(tags, key=parse)


def is_legacy(tag: str) -> bool:
    return isinstance(parse(tag), LegacyVersion)
