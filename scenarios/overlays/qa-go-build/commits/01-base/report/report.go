// Package report renders the nightly stock report.
package report

import (
	"fmt"

	"example.com/qa/inventory/stock"
)

// Line renders one report line.
func Line(i stock.Item) string {
	return fmt.Sprintf("%s: %d available", i.SKU, stock.Available(i))
}
