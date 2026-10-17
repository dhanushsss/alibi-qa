package stock

import "testing"

func TestAvailableNeverNegative(t *testing.T) {
	if got := Available(Item{OnShelf: 2, Reserved: 5}); got != 0 {
		t.Fatalf("got %d, want 0", got)
	}
}
