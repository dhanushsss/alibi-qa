// Package stock tracks item quantities.
package stock

// Item is one stock-keeping unit.
type Item struct {
	SKU      string
	OnShelf  int
	Reserved int
}

// Sellable is what can still be sold.
func Sellable(i Item) int {
	if i.Reserved >= i.OnShelf {
		return 0
	}
	return i.OnShelf - i.Reserved
}
