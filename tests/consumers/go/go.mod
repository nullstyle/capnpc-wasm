module capnp-wasm/fixture

go 1.25.0

require capnproto.org/go/capnp/v3 v3.1.0-alpha.2

require (
	github.com/colega/zeropool v0.0.0-20230505084239-6fb4a4f75381 // indirect
	golang.org/x/sync v0.7.0 // indirect
)

// The host comparison test rewrites this path in its disposable build copy.
replace capnproto.org/go/capnp/v3 => ../../../ref/go-capnp
