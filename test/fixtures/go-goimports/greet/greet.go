// Package greet builds greetings.
package greet

import "strings"

// Hello greets name.
func Hello(name string) string {
	return "hello, " + strings.TrimSpace(name)
}
