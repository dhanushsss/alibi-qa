// Package rates prices parcels by weight.
package rates

import "errors"

// SmallParcelMaxKg is the inclusive upper bound of the small-parcel rate.
const SmallParcelMaxKg = 1.0

// LargeParcelMinKg is the inclusive lower bound of the large-parcel rate.
const LargeParcelMinKg = 20.0

// rateTable lists (upper bound in kg, cents), checked in order.
var rateTable = []struct {
	below float64
	cents int
}{
	{SmallParcelMaxKg, 499},
	{LargeParcelMinKg, 899},
}

// ShippingCents returns the rate for a parcel, in cents.
func ShippingCents(weightKg float64) (int, error) {
	if weightKg <= 0 {
		return 0, errors.New("weight must be positive")
	}
	for _, r := range rateTable {
		if weightKg < r.below {
			return r.cents, nil
		}
	}
	return 2999, nil
}
