// Command other is a second main package, so the tests see a module with
// more than one command.
package main

import "fmt"

func main() {
	fmt.Println("other")
}
