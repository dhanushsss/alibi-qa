// Package session keeps user sessions on disk.
package session

import "os"

// CacheFile is where sessions are persisted between runs.
const CacheFile = ".session-cache"

// Start opens a session and persists it.
func Start(user string) error {
	return os.WriteFile(CacheFile, []byte(user), 0o644)
}

// Active reports whether a persisted session exists.
func Active() bool {
	_, err := os.Stat(CacheFile)
	return err == nil
}
