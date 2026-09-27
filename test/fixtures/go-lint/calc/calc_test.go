package calc

import "testing"

func TestDescribe(t *testing.T) {
	if got := Describe(1, 2); got != "1 + 2 = 3" {
		t.Fatalf("Describe(1, 2) = %q", got)
	}
}
