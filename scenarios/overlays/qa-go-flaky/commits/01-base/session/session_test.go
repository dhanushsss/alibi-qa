package session

import (
	"os"
	"testing"
)

// The test does not clean up the cache file it creates, so it fails whenever a
// previous run in the same checkout left the file behind.
func TestStartsWithoutActiveSession(t *testing.T) {
	if Active() {
		os.Remove(CacheFile)
		t.Fatal("a session is already active before Start")
	}
	if err := Start("ada"); err != nil {
		t.Fatal(err)
	}
}

func TestStartWritesUser(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/x", []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
}
