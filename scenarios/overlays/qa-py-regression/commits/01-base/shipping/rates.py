"""Parcel shipping rates, in cents."""

SMALL_PARCEL_MAX_KG = 1.0
LARGE_PARCEL_MIN_KG = 20.0


def shipping_cents(weight_kg: float) -> int:
    if weight_kg <= 0:
        raise ValueError("weight must be positive")
    if weight_kg <= SMALL_PARCEL_MAX_KG:
        return 499
    if weight_kg >= LARGE_PARCEL_MIN_KG:
        return 2999
    return 899
