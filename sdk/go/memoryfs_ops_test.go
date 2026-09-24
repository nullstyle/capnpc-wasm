package capnpcwasm

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"testing"

	exsys "github.com/tetratelabs/wazero/experimental/sys"
)

func mustOpen(t *testing.T, m *memoryFS, name string, flag exsys.Oflag) exsys.File {
	t.Helper()
	f, errno := m.OpenFile(name, flag, 0644)
	if errno != 0 {
		t.Fatalf("open %q with %d: %v", name, flag, errno)
	}
	return f
}

// TestFilesystemOperations pins the behavior of each operation the command
// guests use on the writable output filesystem.
func TestFilesystemOperations(t *testing.T) {
	limits := DefaultLimits()
	t.Run("open flags", func(t *testing.T) {
		m := newMemoryFS(map[string][]byte{"dir/file": []byte("data")}, false, limits)
		for _, test := range []struct {
			name string
			flag exsys.Oflag
			want exsys.Errno
		}{
			{"dir/file", exsys.O_CREAT | exsys.O_EXCL | exsys.O_RDWR, exsys.EEXIST},
			{"missing", exsys.O_RDONLY, exsys.ENOENT},
			{"missing/child", exsys.O_CREAT | exsys.O_RDWR, exsys.ENOENT},
			{"dir/file/child", exsys.O_CREAT | exsys.O_RDWR, exsys.ENOTDIR},
			{"dir/file", exsys.O_RDONLY | exsys.O_DIRECTORY, exsys.ENOTDIR},
			{"new", exsys.O_CREAT | exsys.O_DIRECTORY, exsys.ENOTDIR},
			{"dir", exsys.O_WRONLY, exsys.EISDIR},
			{"dir", exsys.O_RDWR, exsys.EISDIR},
			{"dir", exsys.O_RDONLY | exsys.O_DIRECTORY, 0},
			{"dir/", exsys.O_RDONLY, 0},
			{"./dir/../dir/file", exsys.O_RDONLY, 0},
			{"/dir/file", exsys.O_RDONLY, 0},
			{"dir/new", exsys.O_CREAT | exsys.O_EXCL | exsys.O_WRONLY, 0},
		} {
			f, errno := m.OpenFile(test.name, test.flag, 0644)
			if errno != test.want {
				t.Errorf("OpenFile(%q, %d) = %v, want %v", test.name, test.flag, errno, test.want)
			}
			if f != nil {
				f.Close()
			}
		}
		if _, errno := m.Stat("dir/new"); errno != 0 {
			t.Fatalf("O_CREAT did not create the file: %v", errno)
		}
		f := mustOpen(t, m, "dir/file", exsys.O_WRONLY|exsys.O_TRUNC)
		f.Close()
		if len(m.snapshot()["dir/file"]) != 0 || m.used != 0 {
			t.Fatalf("O_TRUNC left %q bytes charged at %d", m.snapshot()["dir/file"], m.used)
		}
	})

	// A trailing slash names a directory, as on POSIX: an existing regular
	// file is ENOTDIR, and open cannot create a directory.
	t.Run("trailing slash", func(t *testing.T) {
		m := newMemoryFS(map[string][]byte{"dir/file": []byte("data"), "dir/other": nil}, false, limits)
		for _, test := range []struct {
			operation string
			errno     exsys.Errno
			want      exsys.Errno
		}{
			{"open file/", func() exsys.Errno { _, e := m.OpenFile("dir/file/", exsys.O_RDONLY, 0); return e }(), exsys.ENOTDIR},
			{"stat file/", func() exsys.Errno { _, e := m.Stat("dir/file/"); return e }(), exsys.ENOTDIR},
			{"lstat file/", func() exsys.Errno { _, e := m.Lstat("dir/file/"); return e }(), exsys.ENOTDIR},
			{"unlink file/", m.Unlink("dir/file/"), exsys.ENOTDIR},
			{"rename file/", m.Rename("dir/file/", "moved"), exsys.ENOTDIR},
			{"rename onto file/", m.Rename("dir/other", "dir/file/"), exsys.ENOTDIR},
			{"mkdir file/", m.Mkdir("dir/file/", 0755), exsys.EEXIST},
			{"create new/", func() exsys.Errno { _, e := m.OpenFile("new/", exsys.O_CREAT|exsys.O_WRONLY, 0644); return e }(), exsys.EISDIR},
			{"open dir/", func() exsys.Errno { _, e := m.OpenFile("dir/", exsys.O_RDONLY, 0); return e }(), 0},
			{"stat dir/", func() exsys.Errno { _, e := m.Stat("dir/"); return e }(), 0},
			{"mkdir sub/", m.Mkdir("dir/sub/", 0755), 0},
			{"stat /", func() exsys.Errno { _, e := m.Stat("/"); return e }(), 0},
		} {
			if test.errno != test.want {
				t.Errorf("%s = %v, want %v", test.operation, test.errno, test.want)
			}
		}
		if snapshot := m.snapshot(); !bytes.Equal(snapshot["dir/file"], []byte("data")) || len(snapshot) != 2 {
			t.Fatalf("trailing-slash operations changed the tree: %v", snapshot)
		}
	})

	t.Run("append and offsets", func(t *testing.T) {
		m := newMemoryFS(nil, false, limits)
		f := mustOpen(t, m, "log", exsys.O_CREAT|exsys.O_RDWR)
		if _, errno := f.Write([]byte("abc")); errno != 0 {
			t.Fatal(errno)
		}
		if n, errno := f.Pwrite([]byte("X"), 1); n != 1 || errno != 0 {
			t.Fatalf("Pwrite = %d, %v", n, errno)
		}
		buf := make([]byte, 8)
		if n, errno := f.Pread(buf, 0); n != 3 || errno != 0 || string(buf[:n]) != "aXc" {
			t.Fatalf("Pread = %q, %v", buf[:n], errno)
		}
		if n, errno := f.Pread(buf, 3); n != 0 || errno != 0 {
			t.Fatalf("Pread at end = %d, %v", n, errno)
		}
		if _, errno := f.Pread(buf, -1); errno != exsys.EINVAL {
			t.Fatalf("negative Pread: %v", errno)
		}
		if _, errno := f.Pwrite(buf, -1); errno != exsys.EINVAL {
			t.Fatalf("negative Pwrite: %v", errno)
		}
		f.Close()

		a := mustOpen(t, m, "log", exsys.O_WRONLY|exsys.O_APPEND)
		if !a.IsAppend() {
			t.Fatal("O_APPEND not recorded")
		}
		if _, errno := a.Seek(0, io.SeekStart); errno != 0 {
			t.Fatal(errno)
		}
		if _, errno := a.Write([]byte("d")); errno != 0 {
			t.Fatal(errno)
		}
		if _, errno := a.Read(buf); errno != exsys.EBADF {
			t.Fatalf("write-only handle readable: %v", errno)
		}
		a.Close()
		if got := m.snapshot()["log"]; !bytes.Equal(got, []byte("aXcd")) {
			t.Fatalf("append wrote %q", got)
		}
		if m.used != 4 {
			t.Fatalf("used = %d, want 4", m.used)
		}

		r := mustOpen(t, m, "log", exsys.O_RDONLY)
		for _, test := range []struct {
			offset int64
			whence int
			want   int64
			errno  exsys.Errno
		}{
			{2, io.SeekStart, 2, 0},
			{1, io.SeekCurrent, 3, 0},
			{-1, io.SeekEnd, 3, 0},
			{-4, io.SeekCurrent, 0, exsys.EINVAL},
			{int64(limits.OutputBytes) + 1, io.SeekStart, 0, exsys.EINVAL},
			{0, 7, 0, exsys.EINVAL},
		} {
			got, errno := r.Seek(test.offset, test.whence)
			if errno != test.errno || (errno == 0 && got != test.want) {
				t.Errorf("Seek(%d, %d) = %d, %v, want %d, %v", test.offset, test.whence, got, errno, test.want, test.errno)
			}
		}
		if _, errno := r.Seek(1, io.SeekStart); errno != 0 {
			t.Fatal(errno)
		}
		if n, errno := r.Read(buf); n != 3 || errno != 0 || string(buf[:n]) != "Xcd" {
			t.Fatalf("Read after Seek = %q, %v", buf[:n], errno)
		}
		if _, errno := r.Write([]byte("x")); errno != exsys.EBADF {
			t.Fatalf("read-only handle writable: %v", errno)
		}
		r.Close()
		for _, errno := range []exsys.Errno{
			func() exsys.Errno { _, e := r.Read(buf); return e }(),
			func() exsys.Errno { _, e := r.Seek(0, io.SeekStart); return e }(),
			func() exsys.Errno { _, e := r.Stat(); return e }(),
			r.SetAppend(true),
		} {
			if errno != exsys.EBADF {
				t.Fatalf("closed handle answered: %v", errno)
			}
		}
		if m.limit != "" {
			t.Fatalf("operations within the budgets recorded %q", m.limit)
		}
	})

	t.Run("directories", func(t *testing.T) {
		m := newMemoryFS(map[string][]byte{"file": nil}, false, limits)
		for _, test := range []struct {
			name string
			want exsys.Errno
		}{
			{"dir", 0},
			{"dir", exsys.EEXIST},
			{"file", exsys.EEXIST},
			{"missing/child", exsys.ENOENT},
			{"file/child", exsys.ENOTDIR},
			{"dir/c", 0},
			{"dir/a", 0},
			{"../escape", exsys.EPERM},
		} {
			if errno := m.Mkdir(test.name, 0755); errno != test.want {
				t.Errorf("Mkdir(%q) = %v, want %v", test.name, errno, test.want)
			}
		}
		b := mustOpen(t, m, "dir/b", exsys.O_CREAT|exsys.O_WRONLY)
		b.Close()
		stat, errno := m.Stat("dir")
		if errno != 0 || !stat.Mode.IsDir() {
			t.Fatalf("Stat(dir) = %+v, %v", stat, errno)
		}
		if _, errno := m.Lstat("missing"); errno != exsys.ENOENT {
			t.Fatalf("Lstat(missing) = %v", errno)
		}

		d := mustOpen(t, m, "dir", exsys.O_RDONLY|exsys.O_DIRECTORY)
		if isDir, _ := d.IsDir(); !isDir {
			t.Fatal("directory handle is not a directory")
		}
		var names []string
		for {
			entries, errno := d.Readdir(2)
			if errno != 0 {
				t.Fatal(errno)
			}
			if len(entries) == 0 {
				break
			}
			if len(entries) > 2 {
				t.Fatalf("Readdir(2) returned %d entries", len(entries))
			}
			for _, entry := range entries {
				names = append(names, entry.Name)
				if entry.Type.IsDir() != (entry.Name != "b") {
					t.Errorf("entry %q type %v", entry.Name, entry.Type)
				}
			}
		}
		if fmt.Sprint(names) != "[a b c]" {
			t.Fatalf("Readdir paged %v, want sorted a b c", names)
		}
		if _, errno := d.Seek(0, io.SeekStart); errno != 0 {
			t.Fatal(errno)
		}
		if entries, errno := d.Readdir(0); errno != 0 || len(entries) != 3 {
			t.Fatalf("Readdir after rewind = %d entries, %v", len(entries), errno)
		}
		if _, errno := d.Seek(1, io.SeekStart); errno != exsys.EINVAL {
			t.Fatalf("directory Seek to 1: %v", errno)
		}
		if _, errno := d.Pread(make([]byte, 1), 0); errno != exsys.EISDIR {
			t.Fatalf("directory read: %v", errno)
		}
		if _, errno := d.Readdir(0); errno != 0 {
			t.Fatal(errno)
		}
		d.Close()
		if _, errno := d.Readdir(0); errno != exsys.EBADF {
			t.Fatalf("closed directory readable: %v", errno)
		}
		f := mustOpen(t, m, "file", exsys.O_RDONLY)
		if _, errno := f.Readdir(0); errno != exsys.EBADF {
			t.Fatalf("Readdir on a file: %v", errno)
		}
		f.Close()
	})

	t.Run("rename and unlink", func(t *testing.T) {
		m := newMemoryFS(map[string][]byte{"a": []byte("A"), "b": []byte("BB"), "dir/c": nil}, false, limits)
		for _, test := range []struct {
			from, to string
			want     exsys.Errno
		}{
			{"missing", "x", exsys.ENOENT},
			{"dir", "moved", exsys.ENOSYS},
			{"a", "missing/x", exsys.ENOENT},
			{"a", "dir", exsys.EISDIR},
			{"a", "../x", exsys.EPERM},
			{"a", "a", 0},
			{"a", "b", 0},
			{"b", "dir/d", 0},
		} {
			if errno := m.Rename(test.from, test.to); errno != test.want {
				t.Errorf("Rename(%q, %q) = %v, want %v", test.from, test.to, errno, test.want)
			}
		}
		snapshot := m.snapshot()
		if _, exists := snapshot["a"]; exists || !bytes.Equal(snapshot["dir/d"], []byte("A")) {
			t.Fatalf("rename over an existing file left %v", snapshot)
		}
		for _, test := range []struct {
			name string
			want exsys.Errno
		}{
			{"missing", exsys.ENOENT},
			{"dir", exsys.EISDIR},
			{"dir/c", 0},
			{"dir/c", exsys.ENOENT},
		} {
			if errno := m.Unlink(test.name); errno != test.want {
				t.Errorf("Unlink(%q) = %v, want %v", test.name, errno, test.want)
			}
		}
		if used := m.used; used != 3 {
			t.Fatalf("used = %d after unlink, want the original 3 bytes still charged", used)
		}
		// Only the rename to a new name ("dir/d") created an entry.
		if m.created != 1 {
			t.Fatalf("created = %d, want 1 for the rename to a new name", m.created)
		}
	})

	// The entry budget counts every entry a guest creates over the filesystem's
	// lifetime, excluding the root: OutputEntries entries fit exactly.
	t.Run("entry cap", func(t *testing.T) {
		m := newMemoryFS(nil, false, limits)
		var errno exsys.Errno
		created := 0
		for created <= limits.OutputEntries {
			var f exsys.File
			if f, errno = m.OpenFile(fmt.Sprintf("f%d", created), exsys.O_CREAT|exsys.O_WRONLY, 0644); errno != 0 {
				break
			}
			f.Close()
			created++
		}
		if errno != exsys.ERANGE || created != limits.OutputEntries || len(m.nodes) != limits.OutputEntries+1 {
			t.Fatalf("created %d files, then %v with %d nodes; want ERANGE after %d entries plus the root", created, errno, len(m.nodes), limits.OutputEntries)
		}
		if errno := m.Mkdir("d", 0755); errno != exsys.ERANGE {
			t.Fatalf("Mkdir past the entry cap: %v", errno)
		}
		if m.limit != "outputEntries" {
			t.Fatalf("exceeded budget recorded as %q, want outputEntries", m.limit)
		}
	})

	t.Run("lifetime entry budget", func(t *testing.T) {
		bounded := limits
		bounded.OutputEntries = 2
		m := newMemoryFS(nil, false, bounded)
		mustOpen(t, m, "a", exsys.O_CREAT|exsys.O_WRONLY).Close()
		if errno := m.Unlink("a"); errno != 0 {
			t.Fatal(errno)
		}
		mustOpen(t, m, "b", exsys.O_CREAT|exsys.O_WRONLY).Close()
		if _, errno := m.OpenFile("c", exsys.O_CREAT|exsys.O_WRONLY, 0644); errno != exsys.ERANGE {
			t.Fatalf("third creation after an unlink: %v, want ERANGE (removal does not refund)", errno)
		}
		if errno := m.Rename("b", "moved"); errno != exsys.ERANGE {
			t.Fatalf("rename to a new name past the budget: %v", errno)
		}
		if errno := m.Rename("b", "b"); errno != 0 {
			t.Fatalf("rename to the same name: %v", errno)
		}
		if m.limit != "outputEntries" {
			t.Fatalf("exceeded budget recorded as %q", m.limit)
		}
	})

	t.Run("byte budget", func(t *testing.T) {
		bounded := limits
		bounded.OutputBytes = 4
		m := newMemoryFS(nil, false, bounded)
		f := mustOpen(t, m, "a", exsys.O_CREAT|exsys.O_RDWR)
		if _, errno := f.Write([]byte("abcd")); errno != 0 {
			t.Fatalf("write at the budget: %v", errno)
		}
		if _, errno := f.Write([]byte("e")); errno != exsys.ERANGE {
			t.Fatalf("write past the budget: %v", errno)
		}
		if _, errno := f.Pwrite([]byte("x"), 5); errno != exsys.ERANGE {
			t.Fatalf("sparse write past the budget: %v", errno)
		}
		if errno := f.Truncate(2); errno != 0 {
			t.Fatal(errno)
		}
		if _, errno := f.Pwrite([]byte("xy"), 2); errno != 0 {
			t.Fatalf("write after shrinking: %v", errno)
		}
		if _, errno := f.Write([]byte("z")); errno != exsys.ERANGE {
			t.Fatalf("sparse write from the old offset past the budget: %v", errno)
		}
		if m.limit != "outputBytes" {
			t.Fatalf("exceeded budget recorded as %q", m.limit)
		}
	})

	// Created names are bounded by pathBytes; lookups are bounded at pathBytes
	// plus the longest mount prefix and simply miss beyond the budget. A
	// creating operation records the budget at either bound.
	t.Run("path budget", func(t *testing.T) {
		bounded := limits
		bounded.PathBytes = 3
		m := newMemoryFS(nil, false, bounded)
		mustOpen(t, m, "abc", exsys.O_CREAT|exsys.O_WRONLY).Close()
		if _, errno := m.OpenFile("abcd", exsys.O_CREAT|exsys.O_WRONLY, 0644); errno != exsys.ENAMETOOLONG {
			t.Fatalf("creating a name over pathBytes: %v", errno)
		}
		if errno := m.Mkdir("abcd", 0755); errno != exsys.ENAMETOOLONG {
			t.Fatalf("creating a directory over pathBytes: %v", errno)
		}
		if errno := m.Rename("abc", "abcd"); errno != exsys.ENAMETOOLONG {
			t.Fatalf("renaming to a name over pathBytes: %v", errno)
		}
		if _, errno := m.Stat("/include/abc"); errno != exsys.ENOENT {
			t.Fatalf("lookup within the mount prefix allowance: %v, want ENOENT", errno)
		}
		if _, errno := m.Stat("/include/abcd"); errno != exsys.ENAMETOOLONG {
			t.Fatalf("lookup beyond the mount prefix allowance: %v, want ENAMETOOLONG", errno)
		}
		if _, errno := m.Stat("./abc"); errno != 0 {
			t.Fatalf("lookup of a created name: %v", errno)
		}
		if m.limit != "pathBytes" {
			t.Fatalf("exceeded budget recorded as %q", m.limit)
		}
		if got := m.snapshot(); len(got) != 1 {
			t.Fatalf("rejected names changed the tree: %v", got)
		}

		// Beyond the lookup bound, a lookup or removal is a plain ENAMETOOLONG
		// (nothing that long can exist), while a creation is still the
		// exceeded budget.
		beyond := strings.Repeat("b", bounded.PathBytes+longestMountPrefix+1)
		for _, test := range []struct {
			name  string
			errno func(m *memoryFS) exsys.Errno
			limit string
		}{
			{"stat", func(m *memoryFS) exsys.Errno { _, e := m.Stat(beyond); return e }, ""},
			{"open", func(m *memoryFS) exsys.Errno { _, e := m.OpenFile(beyond, exsys.O_RDONLY, 0); return e }, ""},
			{"readlink", func(m *memoryFS) exsys.Errno { _, e := m.Readlink(beyond); return e }, ""},
			{"unlink", func(m *memoryFS) exsys.Errno { return m.Unlink(beyond) }, ""},
			{"rename from", func(m *memoryFS) exsys.Errno { return m.Rename(beyond, "x") }, ""},
			{"create", func(m *memoryFS) exsys.Errno {
				_, e := m.OpenFile(beyond, exsys.O_CREAT|exsys.O_WRONLY, 0644)
				return e
			}, "pathBytes"},
			{"mkdir", func(m *memoryFS) exsys.Errno { return m.Mkdir(beyond, 0755) }, "pathBytes"},
			{"rename to", func(m *memoryFS) exsys.Errno { return m.Rename("abc", beyond) }, "pathBytes"},
		} {
			m := newMemoryFS(map[string][]byte{"abc": nil}, false, bounded)
			if errno := test.errno(m); errno != exsys.ENAMETOOLONG {
				t.Errorf("%s beyond the lookup bound: %v, want ENAMETOOLONG", test.name, errno)
			}
			if m.limit != test.limit {
				t.Errorf("%s beyond the lookup bound recorded %q, want %q", test.name, m.limit, test.limit)
			}
		}
		// A read-only mount never records a budget.
		readonly := newMemoryFS(map[string][]byte{"abc": nil}, true, bounded)
		if _, errno := readonly.OpenFile(beyond, exsys.O_CREAT|exsys.O_WRONLY, 0644); errno != exsys.ENAMETOOLONG || readonly.limit != "" {
			t.Fatalf("read-only creation beyond the bound: %v, recorded %q", errno, readonly.limit)
		}
	})

	t.Run("mirrored absolute lookups", func(t *testing.T) {
		// The compiler opens /src/<path> through the root mount; the mirror's
		// lookup allowance covers the caller's full pathBytes plus the prefix.
		long := strings.Repeat("a", limits.PathBytes)
		m := newMemoryFS(map[string][]byte{"src/" + long: []byte("x")}, true, limits)
		if _, errno := m.Stat("/src/" + long); errno != 0 {
			t.Fatalf("mirrored lookup of a %d-byte path: %v", len("/src/"+long), errno)
		}
	})
}
