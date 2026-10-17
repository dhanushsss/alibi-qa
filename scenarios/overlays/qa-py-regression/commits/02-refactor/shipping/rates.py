"""Parcel shipping rates, in cents."""

SMALL_PARCEL_MAX_KG = 1.0
LARGE_PARCEL_MIN_KG = 20.0

# (upper bound in kg, cents), checked in order.
RATE_TABLE = (
    (SMALL_PARCEL_MAX_KG, 499),
    (LARGE_PARCEL_MIN_KG, 899),
)


def shipping_cents(weight_kg: float) -> int:
    if weight_kg <= 0:
        raise ValueError("weight must be positive")
    for bound, cents in RATE_TABLE:
        if weight_kg < bound:
            return cents
    return 2999
