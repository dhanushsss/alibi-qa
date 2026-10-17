package report

import (
	"testing"

	"example.com/qa/inventory/stock"
)

func TestLine(t *testing.T) {
	if got := Line(stock.Item{SKU: "A-1", OnShelf: 3, Reserved: 1}); got != "A-1: 2 available" {
		t.Fatalf("got %q", got)
	}
}
