package capnpcwasm_test

import (
	"context"
	"testing"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
)

// Run the benchmarks with
//
//	mise exec -- go -C sdk/go test -run '^$' -bench . -benchmem ./...
//
// Every benchmark runs under each engine so the engine tradeoff stays measured.
var engines = []capnpcwasm.Engine{capnpcwasm.EngineAuto, capnpcwasm.EngineCompiler, capnpcwasm.EngineInterpreter}

// rpcRequest is the largest standard workload: the pinned rpc.capnp and
// schema.capnp, which import the C++ annotations.
func rpcRequest(b testing.TB, generators ...capnpcwasm.Language) capnpcwasm.Request {
	src := root(b) + "/ref/capnproto/c++/src/capnp/"
	return capnpcwasm.Request{
		Files: map[string][]byte{
			"capnp/rpc.capnp":    read(b, src+"rpc.capnp"),
			"capnp/schema.capnp": read(b, src+"schema.capnp"),
		},
		IncludeFiles: map[string][]byte{"capnp/c++.capnp": read(b, src+"c++.capnp")},
		Entrypoints:  []string{"capnp/rpc.capnp", "capnp/schema.capnp"},
		Generators:   generators,
	}
}

func benchCompiler(b *testing.B, engine capnpcwasm.Engine) *capnpcwasm.Compiler {
	b.Helper()
	c, err := capnpcwasm.New(context.Background(), loadModules(b), capnpcwasm.WithEngine(engine))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = c.Close(context.Background()) })
	return c
}

// BenchmarkNew measures compiling all five modules into a Compiler.
func BenchmarkNew(b *testing.B) {
	modules := loadModules(b)
	for _, engine := range engines {
		b.Run(engine.String(), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				c, err := capnpcwasm.New(context.Background(), modules, capnpcwasm.WithEngine(engine))
				if err != nil {
					b.Fatal(err)
				}
				_ = c.Close(context.Background())
			}
		})
	}
}

// BenchmarkCompileRPC runs the compiler alone on rpc.capnp and schema.capnp.
func BenchmarkCompileRPC(b *testing.B) {
	for _, engine := range engines {
		b.Run(engine.String(), func(b *testing.B) {
			c := benchCompiler(b, engine)
			request := rpcRequest(b)
			b.ReportAllocs()
			for b.Loop() {
				if _, err := c.Compile(context.Background(), request); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkGenerateCpp runs the cpp generator on the compiled rpc.capnp and
// schema.capnp request.
func BenchmarkGenerateCpp(b *testing.B) {
	for _, engine := range engines {
		b.Run(engine.String(), func(b *testing.B) {
			c := benchCompiler(b, engine)
			compiled, err := c.Compile(context.Background(), rpcRequest(b))
			if err != nil {
				b.Fatal(err)
			}
			request := capnpcwasm.GenerationRequest{Request: compiled.Request, Generators: []capnpcwasm.Language{"cpp"}}
			b.ReportAllocs()
			for b.Loop() {
				if _, err := c.Generate(context.Background(), request); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkGenerate runs each generator on the compiled fixture workspace,
// which every generator supports, to compare the engines per generator.
func BenchmarkGenerate(b *testing.B) {
	for _, language := range allLanguages {
		for _, engine := range engines {
			b.Run(string(language)+"/"+engine.String(), func(b *testing.B) {
				c := benchCompiler(b, engine)
				workspace := fixture(b)
				workspace.Generators = nil
				compiled, err := c.Compile(context.Background(), workspace)
				if err != nil {
					b.Fatal(err)
				}
				request := capnpcwasm.GenerationRequest{Request: compiled.Request, Generators: []capnpcwasm.Language{language}}
				b.ReportAllocs()
				for b.Loop() {
					if _, err := c.Generate(context.Background(), request); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}

// BenchmarkCompileFixture compiles the small fixture workspace with the cpp
// generator: the latency of a typical small job.
func BenchmarkCompileFixture(b *testing.B) {
	for _, engine := range engines {
		b.Run(engine.String(), func(b *testing.B) {
			c := benchCompiler(b, engine)
			request := fixture(b)
			request.Generators = []capnpcwasm.Language{"cpp"}
			b.ReportAllocs()
			for b.Loop() {
				if _, err := c.Compile(context.Background(), request); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
