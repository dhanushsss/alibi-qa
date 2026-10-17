from releases.tags import is_legacy, sort_tags


def test_sorts_release_tags():
    assert sort_tags(["1.10.0", "1.2.0", "1.9.1"]) == ["1.2.0", "1.9.1", "1.10.0"]


def test_detects_legacy_tags():
    assert is_legacy("nightly-2019")
    assert not is_legacy("2.0.0")
