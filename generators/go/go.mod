module capnpc-wasm/generators/go

go 1.25.0

tool capnproto.org/go/capnp/v3/capnpc-go

require (
	capnproto.org/go/capnp/v3 v3.1.0-alpha.2 // indirect
	github.com/colega/zeropool v0.0.0-20230505084239-6fb4a4f75381 // indirect
	golang.org/x/sync v0.7.0 // indirect
)

// The parent repository's gitlink selects the generator and runtime sources.
replace capnproto.org/go/capnp/v3 => ../../ref/go-capnp
