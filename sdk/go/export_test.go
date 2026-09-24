package capnpcwasm

// ActiveJobs reports the number of registered Compile and Generate calls, so
// tests can sequence Close against running jobs without sleeping.
func (c *Compiler) ActiveJobs() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.jobs)
}

// RunningJobs reports the jobs holding an execution slot when
// WithMaxConcurrentJobs bounds them, and every registered job otherwise.
func (c *Compiler) RunningJobs() int {
	if c.slots == nil {
		return c.ActiveJobs()
	}
	return len(c.slots)
}

// IsClosed reports whether Close has marked the Compiler closed.
func (c *Compiler) IsClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// Named returns the limits keyed by their contract names.
func (l Limits) Named() map[string]int {
	named := map[string]int{}
	for _, entry := range l.entries() {
		named[entry.name] = entry.value
	}
	return named
}

// Argv0 exposes the command name a generator runs under.
var Argv0 = argv0
