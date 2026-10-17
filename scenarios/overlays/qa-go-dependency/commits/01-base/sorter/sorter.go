package sorter

import "golang.org/x/exp/slices"

type Task struct {
	Name     string
	Priority int
}

// ByPriority sorts tasks with the most urgent (lowest number) first.
func ByPriority(tasks []Task) {
	slices.SortFunc(tasks, func(a, b Task) bool { return a.Priority < b.Priority })
}
