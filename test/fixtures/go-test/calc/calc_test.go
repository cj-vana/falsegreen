package calc_test

import (
	"testing"

	"example.com/fixture/calc"
)

func TestAdd(t *testing.T) {
	if got := calc.Add(1, 2); got != 3 {
		t.Fatalf("Add(1, 2) = %d, want 3", got)
	}
}
