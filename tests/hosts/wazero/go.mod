module capnp-wasm/tests/hosts/wazero

go 1.25.0

require github.com/tetratelabs/wazero v1.12.0

require golang.org/x/sys v0.44.0 // indirect

// The parent repository's gitlink selects the runtime under test.
replace github.com/tetratelabs/wazero => ../../../ref/wazero
