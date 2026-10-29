// Package greet is a library package: ko must not try to build it as an
// image.
package greet

// Hello greets name.
func Hello(name string) string {
	return "hello, " + name
}
