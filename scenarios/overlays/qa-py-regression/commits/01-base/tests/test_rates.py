import pytest

from shipping.rates import shipping_cents


def test_small_parcel_up_to_and_including_1kg():
    assert shipping_cents(0.5) == 499
    assert shipping_cents(1.0) == 499


def test_standard_parcel():
    assert shipping_cents(5) == 899


class TestLargeParcels:
    @pytest.mark.parametrize("kg", [20, 35.5])
    def test_large_rate(self, kg):
        assert shipping_cents(kg) == 2999


def test_rejects_non_positive_weight():
    with pytest.raises(ValueError):
        shipping_cents(0)
