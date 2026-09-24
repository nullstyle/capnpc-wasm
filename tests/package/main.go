package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"time"
)

func main() {
	root := os.Args[1]
	read := func(path string) []byte {
		bytes, err := os.ReadFile(filepath.Join(root, path))
		if err != nil {
			panic(err)
		}
		return bytes
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	compiler, err := capnpcwasm.New(ctx, capnpcwasm.Modules{
		Compiler: read("wasm/capnp.wasm"), Generators: map[capnpcwasm.Language][]byte{
			"cpp": read("wasm/capnpc-c++.wasm"), "rust": read("wasm/capnpc-rust.wasm"),
			"go": read("wasm/capnpc-go.wasm"), "zig": read("wasm/capnpc-zig.wasm"),
		},
	}, capnpcwasm.WithLimits(capnpcwasm.DefaultLimits()))
	if err != nil {
		panic(err)
	}
	defer compiler.Close(ctx)
	schema, err := os.ReadFile("schema.capnp")
	if err != nil {
		panic(err)
	}
	languages := []capnpcwasm.Language{"cpp", "rust", "go", "zig"}
	result, err := compiler.Compile(ctx, capnpcwasm.Request{
		Files: map[string][]byte{"candidate.capnp": schema}, IncludeFiles: map[string][]byte{"go.capnp": read("include/go.capnp")},
		Entrypoints: []string{"candidate.capnp"}, Generators: languages,
	})
	if err != nil {
		panic(err)
	}
	if len(result.Diagnostics) != 0 {
		panic(fmt.Sprintf("unexpected diagnostics: %+v", result.Diagnostics))
	}
	regenerated, err := compiler.Generate(ctx, capnpcwasm.GenerationRequest{Request: result.Request, Generators: languages})
	if err != nil {
		panic(err)
	}
	if len(regenerated.Diagnostics) != 0 {
		panic(fmt.Sprintf("unexpected replay diagnostics: %+v", regenerated.Diagnostics))
	}
	digest := func(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
	// Compare the complete digest maps: the same languages and file sets, not
	// only the files the first run produced.
	digests := func(outputs map[capnpcwasm.Language]map[string][]byte) map[string]string {
		hashes := map[string]string{}
		for language, files := range outputs {
			for name, data := range files {
				hashes[string(language)+"/"+name] = digest(data)
			}
		}
		return hashes
	}
	hashes := digests(result.Outputs)
	if !reflect.DeepEqual(hashes, digests(regenerated.Outputs)) {
		panic("replay produced a different file set or bytes")
	}
	expected := map[capnpcwasm.Language]string{"cpp": "candidate.capnp.h", "rust": "candidate_capnp.rs", "go": "candidate.capnp.go", "zig": "candidate.zig"}
	if len(result.Outputs) != len(languages) {
		panic(fmt.Sprintf("generated %d languages, want %d", len(result.Outputs), len(languages)))
	}
	for language, name := range expected {
		if len(result.Outputs[language][name]) == 0 {
			panic("missing output for " + string(language))
		}
	}
	hashes["request"] = digest(result.Request)
	encoded, err := json.Marshal(hashes)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile("go-result.json", encoded, 0600); err != nil {
		panic(err)
	}

	// The shared compiler-path fixture (tests/package/compiler-path-fixture.ts):
	// ordered import roots and a source prefix, resolved inside the snapshot.
	fixture := capnpcwasm.Request{
		Files: map[string][]byte{
			"workspace/app/person.capnp": []byte(`@0xece4bf9c1f867623; using Common = import "/common.capnp"; using Parent = import "../parent.capnp"; struct Person { selected @0 :Common.Value; parent @1 :Parent.Value; bytes @2 :Data = embed "../bytes.bin"; }`),
			"workspace/parent.capnp":     []byte("@0x9c9e5ec72c9f6a21; struct Value { label @0 :Text; }"),
			"workspace/bytes.bin":        {0, 128, 255, 42},
			"outside.capnp":              []byte("@0xe730e9b7daf07b13; struct Outside { value @0 :Bool; }"),
			"roots/first/common.capnp":   []byte("@0xb4bbd4e34c6f77f1; struct Value { first @0 :UInt32; }"),
			"roots/second/common.capnp":  []byte("@0xdbca7fc6b19b98a3; struct Value { second @0 :UInt64; }"),
		},
		Entrypoints:  []string{"workspace/app/person.capnp", "outside.capnp"},
		ImportPaths:  []string{"roots/first", "roots/second"},
		SourcePrefix: "workspace",
	}
	paths := map[string]string{}
	var requests [][]byte
	for _, key := range []string{"paths/request", "paths/request-reversed"} {
		compiled, err := compiler.Compile(ctx, fixture)
		if err != nil {
			panic(err)
		}
		if len(compiled.Diagnostics) != 0 {
			panic(fmt.Sprintf("unexpected path fixture diagnostics: %+v", compiled.Diagnostics))
		}
		// The source prefix strips workspace/ from the requested file name.
		if !bytes.Contains(compiled.Request, []byte("app/person.capnp")) || bytes.Contains(compiled.Request, []byte("workspace/app/person.capnp")) {
			panic("sourcePrefix was not applied to the requested file name")
		}
		paths[key] = digest(compiled.Request)
		requests = append(requests, compiled.Request)
		slices.Reverse(fixture.ImportPaths)
	}
	if bytes.Equal(requests[0], requests[1]) {
		panic("import root order did not change the request")
	}
	encoded, err = json.Marshal(paths)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile("go-paths.json", encoded, 0600); err != nil {
		panic(err)
	}
	fmt.Println("External Go compile, replay, and compiler-path consumer passed")
}
