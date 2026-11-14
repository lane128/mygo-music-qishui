//go:build !qishui_diagnostics

package main

// noteIsolation is empty in released builds; diagnostics.go is only compiled
// for local test packages.
func noteIsolation(string, int, string) {}
