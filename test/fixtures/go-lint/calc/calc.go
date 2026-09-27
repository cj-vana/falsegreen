// Package calc adds numbers.
package calc

import "fmt"

// Add returns a plus b.
func Add(a, b int) int {
	return a + b
}

// Describe prints a sum.
func Describe(a, b int) string {
	return fmt.Sprintf("%d + %d = %d", a, b, Add(a, b))
}
