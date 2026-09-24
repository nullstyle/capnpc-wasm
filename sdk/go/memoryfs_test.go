package capnpcwasm

import (
	"bytes"
	"testing"

	exsys "github.com/tetratelabs/wazero/experimental/sys"
)

func TestFilesystemCapabilities(t *testing.T) {
	readonly := newMemoryFS(map[string][]byte{"secret": []byte("schema")}, true, DefaultLimits())
	for _, flags := range []exsys.Oflag{exsys.O_WRONLY, exsys.O_RDWR, exsys.O_CREAT, exsys.O_TRUNC, exsys.O_APPEND} {
		if _, errno := readonly.OpenFile("secret", flags, 0644); errno != exsys.EROFS {
			t.Errorf("read-only open with %d: %v", flags, errno)
		}
	}
	if errno := readonly.Mkdir("directory", 0755); errno != exsys.EROFS {
		t.Fatal(errno)
	}
	if errno := readonly.Unlink("secret"); errno != exsys.EROFS {
		t.Fatal(errno)
	}
	if errno := readonly.Rename("secret", "moved"); errno != exsys.EROFS {
		t.Fatal(errno)
	}
	if errno := readonly.Symlink("secret", "link"); errno != exsys.ENOSYS {
		t.Fatal(errno)
	}
	output := newMemoryFS(nil, false, DefaultLimits())
	for _, name := range []string{"../secret", "dir/../../secret", "bad\\name", "bad\x00name"} {
		if _, errno := output.OpenFile(name, exsys.O_CREAT|exsys.O_RDWR, 0644); errno != exsys.EPERM {
			t.Errorf("escape %q: %v", name, errno)
		}
	}
	if _, errno := output.OpenFile("secret", exsys.O_RDONLY, 0); errno != exsys.ENOENT {
		t.Fatal("generator saw compiler inputs")
	}
	if len(output.snapshot()) != 0 || output.limit != "" {
		t.Fatal("rejected paths created output or charged a budget")
	}
}

func TestFilesystemOutputLimitAndTruncation(t *testing.T) {
	limits := DefaultLimits()
	budget := int64(limits.OutputBytes)
	m := newMemoryFS(nil, false, limits)
	f, errno := m.OpenFile("file", exsys.O_CREAT|exsys.O_RDWR, 0644)
	if errno != 0 {
		t.Fatal(errno)
	}
	if _, errno = f.Write([]byte("old data")); errno != 0 {
		t.Fatal(errno)
	}
	if errno = f.Truncate(3); errno != 0 {
		t.Fatal(errno)
	}
	if errno = f.Truncate(8); errno != 0 {
		t.Fatal(errno)
	}
	if !bytes.Equal(m.snapshot()["file"], []byte{'o', 'l', 'd', 0, 0, 0, 0, 0}) {
		t.Fatal("truncated bytes became visible again")
	}
	if m.limit != "" {
		t.Fatalf("writes within the budget recorded %q", m.limit)
	}
	if _, errno = f.Pwrite([]byte("x"), budget); errno != exsys.ERANGE {
		t.Fatal("oversized sparse write accepted")
	}
	if errno = f.Truncate(budget + 1); errno != exsys.ERANGE {
		t.Fatal("oversized truncate accepted")
	}
	if m.limit != "outputBytes" {
		t.Fatalf("exceeded budget recorded as %q, want outputBytes", m.limit)
	}
	if len(m.snapshot()["file"]) != 8 {
		t.Fatal("rejected writes mutated data")
	}
	if errno = f.Close(); errno != 0 {
		t.Fatal(errno)
	}
	if _, errno = f.Write([]byte("x")); errno != exsys.EBADF {
		t.Fatal("closed handle remains writable")
	}
}

func TestFilesystemReadlinkProbes(t *testing.T) {
	m := newMemoryFS(map[string][]byte{"nested/file.zig": []byte("generated")}, false, DefaultLimits())
	for _, test := range []struct {
		path string
		want exsys.Errno
	}{
		{".", exsys.EINVAL},
		{"nested", exsys.EINVAL},
		{"nested/file.zig", exsys.EINVAL},
		{"nested/missing", exsys.ENOENT},
		{"missing/child", exsys.ENOENT},
		{"nested/file.zig/child", exsys.ENOTDIR},
		{"nested/file.zig/", exsys.ENOTDIR},
		{"", exsys.ENOENT},
		{"../outside", exsys.EPERM},
		{"bad\x00name", exsys.EPERM},
	} {
		t.Run(test.path, func(t *testing.T) {
			target, errno := m.Readlink(test.path)
			if errno != test.want || target != "" {
				t.Fatalf("Readlink(%q) = (%q, %v), want empty target and %v", test.path, target, errno, test.want)
			}
		})
	}
	if !bytes.Equal(m.snapshot()["nested/file.zig"], []byte("generated")) {
		t.Fatal("Readlink mutated output")
	}
}
