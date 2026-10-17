package invoice

import "testing"

func TestTotal(t *testing.T) {
	if Total([]int{100, 250}) != 350 {
		t.Fatal("total")
	}
}
