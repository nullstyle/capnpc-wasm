package capnpcwasm

import (
	"io/fs"
	"path"
	"strings"
	"testing"
	"unicode/utf8"

	exsys "github.com/tetratelabs/wazero/experimental/sys"
)

var pathSeeds = []string{
	"", ".", "..", "/", "a", "a/b", "a//b", "/a", "a/", "./a", "a/./b", "a/../b", "a/b/..", "a/..", "../a", "a/../..",
	"a\\b", "a\x00b", "\xff", "é/🦀", "..a", "a..", "...", ". ", "a/.../b",
	strings.Repeat("a", 4096), strings.Repeat("a", 4097), strings.Repeat("../", 10) + "a", strings.Repeat("a/", 2048) + "b",
}

// FuzzValidPath checks the workspace path rule against the standard library:
// validPath accepts exactly the paths fs.ValidPath accepts, minus ".", and
// paths with backslashes or NUL bytes. Length is bounded separately by the
// pathBytes limit.
func FuzzValidPath(f *testing.F) {
	for _, seed := range pathSeeds {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, name string) {
		want := fs.ValidPath(name) && name != "." &&
			utf8.ValidString(name) && !strings.ContainsAny(name, "\\\x00")
		if got := validPath(name); got != want {
			t.Fatalf("validPath(%q) = %v, want %v", name, got, want)
		}
	})
}

// FuzzGuestPath checks guest path resolution against path.Clean for paths
// that stay inside the mount, and its errors for paths that do not.
func FuzzGuestPath(f *testing.F) {
	for _, seed := range pathSeeds {
		f.Add(seed)
	}
	const maximum = 4096
	f.Fuzz(func(t *testing.T, name string) {
		got, errno := guestPath(name, maximum)
		switch {
		case len(name) > maximum:
			if errno != exsys.ENAMETOOLONG || got != "" {
				t.Fatalf("guestPath(%d bytes) = (%q, %v), want ENAMETOOLONG", len(name), got, errno)
			}
			return
		case strings.ContainsAny(name, "\\\x00"):
			if errno != exsys.EPERM || got != "" {
				t.Fatalf("guestPath(%q) = (%q, %v), want EPERM", name, got, errno)
			}
			return
		case ascends(name):
			if errno != exsys.EPERM || got != "" {
				t.Fatalf("guestPath(%q) = (%q, %v), want EPERM for ascending above the mount", name, got, errno)
			}
			return
		}
		want := strings.TrimPrefix(path.Clean("/"+name), "/")
		if want == "" {
			want = "."
		}
		if errno != 0 || got != want {
			t.Fatalf("guestPath(%q) = (%q, %v), want (%q, 0)", name, got, errno, want)
		}
		if got != "." {
			for _, part := range strings.Split(got, "/") {
				if part == "" || part == "." || part == ".." {
					t.Fatalf("guestPath(%q) = %q keeps a %q component", name, got, part)
				}
			}
		}
		if again, errno := guestPath(got, maximum); errno != 0 || again != got {
			t.Fatalf("guestPath(%q) = (%q, %v) is not a fixed point", got, again, errno)
		}
	})
}

// ascends reports whether a path's ".." components ever outnumber the named
// components before them, which would leave the mount.
func ascends(name string) bool {
	depth := 0
	for _, part := range strings.Split(name, "/") {
		switch part {
		case "", ".":
		case "..":
			if depth == 0 {
				return true
			}
			depth--
		default:
			depth++
		}
	}
	return false
}
