// Command hello prints a greeting. It exists so the tests have a main
// package for ko to build.
package main

import (
	"fmt"

	"example.org/hello/internal/greet"
)

func main() {
	fmt.Println(greet.Hello("ko"))
}
