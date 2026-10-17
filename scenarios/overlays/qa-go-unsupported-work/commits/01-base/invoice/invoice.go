package invoice

// Total sums line amounts in cents.
func Total(lines []int) int {
	t := 0
	for _, l := range lines {
		t += l
	}
	return t
}
