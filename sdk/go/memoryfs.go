package capnpwasm

import (
	"bytes"
	"io"
	"io/fs"
	"path"
	"strings"
	"sync/atomic"

	exsys "github.com/tetratelabs/wazero/experimental/sys"
	"github.com/tetratelabs/wazero/sys"
)

// This filesystem implements the operations used by the pinned command guests.
// It has no host filesystem backing, links, devices, or external resources.
// Each instance belongs to one single-threaded guest; jobs never share nodes.
type memoryFS struct {
	exsys.UnimplementedFS
	nodes    map[string]*memoryNode
	readOnly bool
	used     int64
	nextIno  uint64
	dev      uint64
}

var nextDevice atomic.Uint64

type memoryNode struct {
	data []byte
	mode fs.FileMode
	ino  uint64
	dev  uint64
}

func newMemoryFS(files map[string][]byte, readOnly bool) *memoryFS {
	m := &memoryFS{nodes: map[string]*memoryNode{}, nextIno: 1, dev: nextDevice.Add(1)}
	m.add(".", fs.ModeDir|0755, nil)
	for _, name := range sortedKeys(files) {
		parts := strings.Split(name, "/")
		for i := 1; i < len(parts); i++ {
			dir := strings.Join(parts[:i], "/")
			if m.nodes[dir] == nil {
				m.add(dir, fs.ModeDir|0755, nil)
			}
		}
		m.add(name, 0644, bytes.Clone(files[name]))
	}
	m.readOnly = readOnly
	return m
}

func (m *memoryFS) add(name string, mode fs.FileMode, data []byte) *memoryNode {
	n := &memoryNode{data: data, mode: mode, ino: m.nextIno, dev: m.dev}
	m.nextIno++
	m.nodes[name] = n
	m.used += int64(len(data))
	return n
}

// Guest paths may contain dot components and redundant separators. Resolve
// these only inside this mount and reject attempts to ascend above its root.
func guestPath(name string) (string, exsys.Errno) {
	if len(name) > 4096 {
		return "", exsys.ENAMETOOLONG
	}
	if strings.ContainsAny(name, "\\\x00") {
		return "", exsys.EPERM
	}
	parts := []string{}
	for _, part := range strings.Split(name, "/") {
		switch part {
		case "", ".":
		case "..":
			if len(parts) == 0 {
				return "", exsys.EPERM
			}
			parts = parts[:len(parts)-1]
		default:
			parts = append(parts, part)
		}
	}
	if len(parts) == 0 {
		return ".", 0
	}
	return strings.Join(parts, "/"), 0
}

func (m *memoryFS) parent(name string) exsys.Errno {
	parent := m.nodes[path.Dir(name)]
	if parent == nil {
		return exsys.ENOENT
	}
	if !parent.mode.IsDir() {
		return exsys.ENOTDIR
	}
	return 0
}

func (m *memoryFS) OpenFile(name string, flag exsys.Oflag, perm fs.FileMode) (exsys.File, exsys.Errno) {
	name, errno := guestPath(name)
	if errno != 0 {
		return nil, errno
	}
	writable := flag&(exsys.O_RDWR|exsys.O_WRONLY) != 0
	if m.readOnly && (writable || flag&(exsys.O_CREAT|exsys.O_TRUNC|exsys.O_APPEND) != 0) {
		return nil, exsys.EROFS
	}
	n := m.nodes[name]
	if n == nil {
		if flag&exsys.O_CREAT == 0 {
			return nil, exsys.ENOENT
		}
		if errno := m.parent(name); errno != 0 {
			return nil, errno
		}
		if len(m.nodes) >= maxFiles {
			return nil, exsys.ERANGE
		}
		if flag&exsys.O_DIRECTORY != 0 {
			return nil, exsys.ENOTDIR
		}
		n = m.add(name, perm.Perm(), nil)
	} else if flag&(exsys.O_CREAT|exsys.O_EXCL) == exsys.O_CREAT|exsys.O_EXCL {
		return nil, exsys.EEXIST
	}
	if n.mode.IsDir() && writable {
		return nil, exsys.EISDIR
	}
	if !n.mode.IsDir() && flag&exsys.O_DIRECTORY != 0 {
		return nil, exsys.ENOTDIR
	}
	f := &memoryFile{fs: m, node: n, name: name, readable: flag&exsys.O_WRONLY == 0, writable: writable, appendMode: flag&exsys.O_APPEND != 0}
	if flag&exsys.O_TRUNC != 0 {
		if errno := f.Truncate(0); errno != 0 {
			return nil, errno
		}
	}
	return f, 0
}

func (m *memoryFS) Stat(name string) (sys.Stat_t, exsys.Errno) {
	name, errno := guestPath(name)
	if errno != 0 {
		return sys.Stat_t{}, errno
	}
	n := m.nodes[name]
	if n == nil {
		return sys.Stat_t{}, exsys.ENOENT
	}
	return n.stat(), 0
}

func (m *memoryFS) Lstat(name string) (sys.Stat_t, exsys.Errno) { return m.Stat(name) }

func (m *memoryFS) Mkdir(name string, perm fs.FileMode) exsys.Errno {
	if m.readOnly {
		return exsys.EROFS
	}
	name, errno := guestPath(name)
	if errno != 0 {
		return errno
	}
	if m.nodes[name] != nil {
		return exsys.EEXIST
	}
	if errno := m.parent(name); errno != 0 {
		return errno
	}
	if len(m.nodes) >= maxFiles {
		return exsys.ERANGE
	}
	m.add(name, fs.ModeDir|perm.Perm(), nil)
	return 0
}

func (m *memoryFS) Unlink(name string) exsys.Errno {
	if m.readOnly {
		return exsys.EROFS
	}
	name, errno := guestPath(name)
	if errno != 0 {
		return errno
	}
	n := m.nodes[name]
	if n == nil {
		return exsys.ENOENT
	}
	if n.mode.IsDir() {
		return exsys.EISDIR
	}
	// Keep the allocation charged while existing file handles may retain it.
	delete(m.nodes, name)
	return 0
}

func (m *memoryFS) Rename(from, to string) exsys.Errno {
	if m.readOnly {
		return exsys.EROFS
	}
	from, errno := guestPath(from)
	if errno != 0 {
		return errno
	}
	to, errno = guestPath(to)
	if errno != 0 {
		return errno
	}
	n := m.nodes[from]
	if n == nil {
		return exsys.ENOENT
	}
	if n.mode.IsDir() {
		return exsys.ENOSYS // The command guests only rename regular output files.
	}
	if errno := m.parent(to); errno != 0 {
		return errno
	}
	if old := m.nodes[to]; old != nil && old.mode.IsDir() {
		return exsys.EISDIR
	}
	if from != to {
		delete(m.nodes, from)
		m.nodes[to] = n
	}
	return 0
}

func (m *memoryFS) snapshot() map[string][]byte {
	out := map[string][]byte{}
	for name, node := range m.nodes {
		if !node.mode.IsDir() {
			out[name] = bytes.Clone(node.data)
		}
	}
	return out
}

func (n *memoryNode) stat() sys.Stat_t {
	return sys.Stat_t{Dev: n.dev, Ino: n.ino, Mode: n.mode, Nlink: 1, Size: int64(len(n.data))}
}

type memoryFile struct {
	exsys.UnimplementedFile
	fs         *memoryFS
	node       *memoryNode
	name       string
	offset     int64
	dirOffset  int
	readable   bool
	writable   bool
	appendMode bool
	closed     bool
}

func (f *memoryFile) Dev() (uint64, exsys.Errno)    { return f.node.dev, 0 }
func (f *memoryFile) Ino() (sys.Inode, exsys.Errno) { return f.node.ino, 0 }
func (f *memoryFile) IsDir() (bool, exsys.Errno)    { return f.node.mode.IsDir(), 0 }
func (f *memoryFile) IsAppend() bool                { return f.appendMode }

func (f *memoryFile) SetAppend(enable bool) exsys.Errno {
	if f.closed {
		return exsys.EBADF
	}
	f.appendMode = enable
	return 0
}

func (f *memoryFile) Stat() (sys.Stat_t, exsys.Errno) {
	if f.closed {
		return sys.Stat_t{}, exsys.EBADF
	}
	return f.node.stat(), 0
}

func (f *memoryFile) Read(buf []byte) (int, exsys.Errno) {
	n, errno := f.Pread(buf, f.offset)
	f.offset += int64(n)
	return n, errno
}

func (f *memoryFile) Pread(buf []byte, offset int64) (int, exsys.Errno) {
	if f.closed || !f.readable {
		return 0, exsys.EBADF
	}
	if f.node.mode.IsDir() {
		return 0, exsys.EISDIR
	}
	if offset < 0 {
		return 0, exsys.EINVAL
	}
	if offset >= int64(len(f.node.data)) {
		return 0, 0
	}
	return copy(buf, f.node.data[offset:]), 0
}

func (f *memoryFile) Write(buf []byte) (int, exsys.Errno) {
	if f.appendMode {
		f.offset = int64(len(f.node.data))
	}
	n, errno := f.Pwrite(buf, f.offset)
	f.offset += int64(n)
	return n, errno
}

func (f *memoryFile) Pwrite(buf []byte, offset int64) (int, exsys.Errno) {
	if f.closed || !f.writable {
		return 0, exsys.EBADF
	}
	if offset < 0 || offset > maxBytes || int64(len(buf)) > maxBytes-offset {
		return 0, exsys.ERANGE
	}
	end := offset + int64(len(buf))
	if end > int64(len(f.node.data)) {
		if errno := f.Truncate(end); errno != 0 {
			return 0, errno
		}
	}
	return copy(f.node.data[offset:], buf), 0
}

func (f *memoryFile) Truncate(size int64) exsys.Errno {
	if f.closed || !f.writable {
		return exsys.EBADF
	}
	if f.node.mode.IsDir() {
		return exsys.EISDIR
	}
	if size < 0 {
		return exsys.EINVAL
	}
	delta := size - int64(len(f.node.data))
	if delta > maxBytes-f.fs.used {
		return exsys.ERANGE
	}
	if delta > 0 {
		f.node.data = append(f.node.data, make([]byte, delta)...)
	} else {
		// Release the former backing allocation when shrinking so truncation
		// cannot retain uncharged buffers across thousands of output files.
		f.node.data = bytes.Clone(f.node.data[:size])
	}
	f.fs.used += delta
	return 0
}

// Seek follows experimental/sys.File, whose Errno return differs from io.Seeker.
func (f *memoryFile) Seek(offset int64, whence int) (int64, exsys.Errno) {
	if f.closed {
		return 0, exsys.EBADF
	}
	if f.node.mode.IsDir() {
		if whence != io.SeekStart || offset != 0 {
			return 0, exsys.EINVAL
		}
		f.dirOffset = 0
		return 0, 0
	}
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		offset += f.offset
	case io.SeekEnd:
		offset += int64(len(f.node.data))
	default:
		return 0, exsys.EINVAL
	}
	if offset < 0 || offset > maxBytes {
		return 0, exsys.EINVAL
	}
	f.offset = offset
	return offset, 0
}

func (f *memoryFile) Readdir(n int) ([]exsys.Dirent, exsys.Errno) {
	if f.closed || !f.node.mode.IsDir() {
		return nil, exsys.EBADF
	}
	entries := []exsys.Dirent{}
	for _, name := range sortedKeys(f.fs.nodes) {
		if name != "." && path.Dir(name) == f.name {
			node := f.fs.nodes[name]
			entries = append(entries, exsys.Dirent{Name: path.Base(name), Ino: node.ino, Type: node.mode.Type()})
		}
	}
	start := min(f.dirOffset, len(entries))
	end := len(entries)
	if n > 0 {
		end = min(end, start+n)
	}
	f.dirOffset = end
	return entries[start:end], 0
}

func (f *memoryFile) Close() exsys.Errno {
	f.closed = true
	return 0
}
