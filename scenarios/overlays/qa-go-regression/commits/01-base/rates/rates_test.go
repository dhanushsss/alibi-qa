package rates

import "testing"

func TestShippingCents(t *testing.T) {
	cases := []struct {
		name   string
		weight float64
		want   int
	}{
		{"half_kg", 0.5, 499},
		{"exactly_1kg", 1.0, 499},
		{"five_kg", 5, 899},
		{"exactly_20kg", 20, 2999},
		{"thirty_kg", 30, 2999},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ShippingCents(c.weight)
			if err != nil {
				t.Fatalf("ShippingCents(%v) error: %v", c.weight, err)
			}
			if got != c.want {
				t.Errorf("ShippingCents(%v) = %d, want %d", c.weight, got, c.want)
			}
		})
	}
}

func TestRejectsNonPositiveWeight(t *testing.T) {
	if _, err := ShippingCents(0); err == nil {
		t.Fatal("expected an error for 0 kg")
	}
}
