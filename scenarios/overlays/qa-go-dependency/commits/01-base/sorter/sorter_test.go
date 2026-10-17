package sorter

import "testing"

func TestByPriority(t *testing.T) {
	tasks := []Task{{"b", 2}, {"a", 1}, {"c", 3}}
	ByPriority(tasks)
	if tasks[0].Name != "a" || tasks[2].Name != "c" {
		t.Fatalf("unexpected order: %+v", tasks)
	}
}
