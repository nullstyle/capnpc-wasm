module capnp-wasm/sdk/go

go 1.25.0

require github.com/tetratelabs/wazero v1.12.0

require golang.org/x/sys v0.44.0 // indirect

// The repository gitlink pins standardized exception-handling support.
replace github.com/tetratelabs/wazero => ../../ref/wazero
