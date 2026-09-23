package capnpcwasm

// ActiveJobs reports the number of registered Compile and Generate calls, so
// tests can sequence Close against running jobs without sleeping.
func (c *Compiler) ActiveJobs() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.jobs)
}

// IsClosed reports whether Close has marked the Compiler closed.
func (c *Compiler) IsClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}
